#!/usr/bin/env python3
"""
Node-scaling line graphs from fixed-page benchmark runs.

Reads component_metrics.csv from each result directory, groups by node count,
and plots latency + throughput vs. node count with triangle markers.

Usage:
    python3 benchmark/plot_node_scaling.py <dir1> <dir2> ... [--out <pdf_path>]

    Dirs are auto-discovered if you pass the results root:
    python3 benchmark/plot_node_scaling.py benchmark/results/ --pages 5000

    Or pass the three dirs explicitly:
    python3 benchmark/plot_node_scaling.py \
        benchmark/results/04-21-02:41AM-1nodes-5000pages \
        benchmark/results/04-21-03:01AM-2nodes-5000pages \
        benchmark/results/04-21-02:16AM-3nodes-5000pages
"""

import sys
import os
import csv
import re
import argparse
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import numpy as np

POSTER = {
    'blue':     '#2563eb',
    'cyan':     '#0891b2',
    'green':    '#059669',
    'orange':   '#d97706',
    'pink':     '#db2777',
    'purple':   '#7c3aed',
    'bg':       '#ffffff',
    'surface':  '#f5f5f7',
    'text':     '#1a1a1a',
    'text_dim': '#555555',
    'border':   '#d1d1d6',
}

# One color per component line
COMPONENTS = ['Crawler', 'Indexer', 'Query', 'End-to-End']
COLORS     = [POSTER['blue'], POSTER['green'], POSTER['pink'], POSTER['orange']]


def read_csv(path):
    with open(path, newline='') as f:
        return list(csv.DictReader(f))


def parse_nodes_from_dir(dirname):
    """Extract node count from folder name like '04-21-02:41AM-1nodes-5000pages'."""
    m = re.search(r'(\d+)nodes', os.path.basename(dirname))
    return int(m.group(1)) if m else None


def load_run(result_dir):
    """Return dict of component → {latency_ms, throughput} for one run dir."""
    csv_path = os.path.join(result_dir, 'component_metrics.csv')
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"No component_metrics.csv in {result_dir}")
    rows = read_csv(csv_path)
    data = {}
    for row in rows:
        comp = row['component']
        lat  = float(row['latency_ms'])  if row['latency_ms']  else None
        thr  = float(row['throughput'])  if row['throughput']  else None
        dur  = float(row['duration_ms']) if row['duration_ms'] else None
        data[comp] = {'latency_ms': lat, 'throughput': thr, 'duration_ms': dur}
    return data


def setup_style():
    plt.rcParams.update({
        'figure.facecolor':  POSTER['bg'],
        'axes.facecolor':    POSTER['bg'],
        'axes.edgecolor':    POSTER['border'],
        'axes.labelcolor':   POSTER['text'],
        'text.color':        POSTER['text'],
        'xtick.color':       POSTER['text_dim'],
        'ytick.color':       POSTER['text_dim'],
        'grid.color':        POSTER['border'],
        'grid.alpha':        0.3,
        'legend.framealpha': 0.9,
        'legend.edgecolor':  POSTER['border'],
    })


def style_ax(ax, title, xlabel, ylabel):
    ax.set_title(title, fontsize=14, fontweight='bold', color=POSTER['text'])
    ax.set_xlabel(xlabel, fontsize=12, color=POSTER['text'])
    ax.set_ylabel(ylabel, fontsize=12, color=POSTER['text'])
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['bottom'].set_color(POSTER['border'])
    ax.spines['left'].set_color(POSTER['border'])
    ax.grid(True, alpha=0.3, color=POSTER['border'])
    ax.legend(fontsize=10, loc='best')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('dirs', nargs='+', help='Result dirs or a single results root')
    parser.add_argument('--out', default=None, help='Output PDF path')
    parser.add_argument('--pages', type=int, default=None,
                        help='Filter by page count when auto-discovering from a root dir')
    a = parser.parse_args()

    # Auto-discover: if a single dir is passed and it contains subdirs, treat as root
    dirs = a.dirs
    if len(dirs) == 1 and os.path.isdir(dirs[0]):
        root = dirs[0]
        subdirs = sorted([
            os.path.join(root, d) for d in os.listdir(root)
            if os.path.isdir(os.path.join(root, d))
            and re.search(r'\d+nodes', d)
            and (a.pages is None or f'{a.pages}pages' in d)
        ])
        if subdirs:
            dirs = subdirs

    # Load and sort by node count
    runs = []
    for d in dirs:
        nodes = parse_nodes_from_dir(d)
        if nodes is None:
            print(f"Warning: cannot parse node count from '{d}', skipping")
            continue
        try:
            data = load_run(d)
        except FileNotFoundError as e:
            print(f"Warning: {e}, skipping")
            continue
        runs.append((nodes, data))

    if not runs:
        print("Error: no valid result dirs found")
        sys.exit(1)

    runs.sort(key=lambda x: x[0])
    node_counts = np.array([r[0] for r in runs])

    # Determine output path
    if a.out:
        pdf_path = a.out
    else:
        pages_tag = f"{a.pages}pages" if a.pages else "Xpages"
        nodes_tag = '-'.join(str(n) for n in node_counts)
        pdf_path = os.path.join(
            os.path.dirname(dirs[0]),
            f"node-scaling-{nodes_tag}nodes-{pages_tag}.pdf"
        )

    setup_style()

    # ── Collect series ──
    # Latency: ms/item for Crawler, Indexer, Query; seconds for End-to-End
    latency_series = {}
    throughput_series = {}

    for comp in COMPONENTS:
        lats = []
        thrs = []
        for _, data in runs:
            row = data.get(comp, {})
            if comp == 'End-to-End':
                # Use total duration in seconds as "latency"
                dur = row.get('duration_ms')
                lats.append(dur / 1000.0 if dur is not None else None)
                thrs.append(None)
            else:
                lats.append(row.get('latency_ms'))
                thrs.append(row.get('throughput'))
        latency_series[comp]    = lats
        throughput_series[comp] = thrs

    def safe_plot(ax, x, ys, color, label):
        valid = [(xi, yi) for xi, yi in zip(x, ys) if yi is not None]
        if not valid:
            return
        xs, vs = zip(*valid)
        ax.plot(xs, vs, color=color, marker='^', markersize=10,
                linewidth=2, label=label)
        for xi, yi in zip(xs, vs):
            ax.annotate(f'{yi:.1f}', xy=(xi, yi),
                        xytext=(0, 8), textcoords='offset points',
                        ha='center', fontsize=8, color=color, fontweight='bold')

    with PdfPages(pdf_path) as pdf:
        # ─── Page 1: Components — Latency & Throughput side by side ───
        fig, (ax_lat, ax_thr) = plt.subplots(1, 2, figsize=(16, 7))
        fig.set_facecolor(POSTER['bg'])
        fig.suptitle('Component Scaling (5k pages)', fontsize=16,
                     fontweight='bold', color=POSTER['text'])

        lat_labels = {
            'Crawler': 'Crawler (ms/page)',
            'Indexer': 'Indexer (ms/doc)',
            'Query':   'Query (ms/query)',
        }
        thr_labels = {
            'Crawler': 'Crawler (pages/sec)',
            'Indexer': 'Indexer (docs/sec)',
            'Query':   'Query (queries/sec)',
        }
        for comp, color in zip(COMPONENTS[:3], COLORS[:3]):
            safe_plot(ax_lat, node_counts, latency_series[comp], color, lat_labels[comp])
            safe_plot(ax_thr, node_counts, throughput_series[comp], color, thr_labels[comp])

        ax_lat.set_xticks(node_counts)
        ax_thr.set_xticks(node_counts)
        style_ax(ax_lat, 'Latency vs. Node Count', 'Number of Nodes', 'Latency (ms/item)')
        style_ax(ax_thr, 'Throughput vs. Node Count', 'Number of Nodes', 'Throughput (items/sec)')
        plt.tight_layout()
        pdf.savefig(fig)
        plt.close(fig)

        # ─── Page 2: End-to-End duration ───
        fig, (ax_dur, ax_thr_e2e) = plt.subplots(1, 2, figsize=(16, 7))
        fig.set_facecolor(POSTER['bg'])
        fig.suptitle('End-to-End Scaling (5k pages)', fontsize=16,
                     fontweight='bold', color=POSTER['text'])

        safe_plot(ax_dur, node_counts, latency_series['End-to-End'],
                  COLORS[3], 'Total duration (sec)')

        # End-to-End throughput = pages / total_seconds
        pages_count = a.pages or 5000
        e2e_thr = [
            pages_count / v if v else None
            for v in latency_series['End-to-End']
        ]
        safe_plot(ax_thr_e2e, node_counts, e2e_thr,
                  COLORS[3], 'End-to-End (pages/sec)')

        ax_dur.set_xticks(node_counts)
        ax_thr_e2e.set_xticks(node_counts)
        style_ax(ax_dur, 'Total Duration vs. Node Count', 'Number of Nodes', 'Duration (seconds)')
        style_ax(ax_thr_e2e, 'Throughput vs. Node Count', 'Number of Nodes', 'Throughput (pages/sec)')
        plt.tight_layout()
        pdf.savefig(fig)
        plt.close(fig)

    print(f"Scaling report saved to {pdf_path}")


if __name__ == '__main__':
    main()