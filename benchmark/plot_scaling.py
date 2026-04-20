#!/usr/bin/env python3
"""
Generate scaling line graphs (latency & throughput vs. node count).

Reads:  <scaling_dir>/scaling_summary.csv
Writes: <scaling_dir>/scaling_report.pdf  (2 pages: latency + throughput)

Usage:
    python3 benchmark/plot_scaling.py <scaling_dir>
"""

import sys
import os
import csv
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import numpy as np

# ── Poster color scheme ──
POSTER = {
    'blue': '#2563eb',
    'cyan': '#0891b2',
    'green': '#059669',
    'orange': '#d97706',
    'pink': '#db2777',
    'purple': '#7c3aed',
    'red': '#dc2626',
    'yellow': '#ca8a04',
    'bg': '#ffffff',
    'surface': '#f5f5f7',
    'surface2': '#eeeef0',
    'text': '#1a1a1a',
    'text_dim': '#555555',
    'border': '#d1d1d6',
}

# 3 lines: Crawler, Indexer, End-to-End
LINE_COLORS = [POSTER['blue'], POSTER['green'], POSTER['orange']]
LINE_LABELS = ['Crawler', 'Indexer', 'End-to-End']


def read_csv(path):
    with open(path, newline='') as f:
        return list(csv.DictReader(f))


def setup_style():
    plt.rcParams.update({
        'figure.facecolor': POSTER['bg'],
        'axes.facecolor': POSTER['bg'],
        'axes.edgecolor': POSTER['border'],
        'axes.labelcolor': POSTER['text'],
        'text.color': POSTER['text'],
        'xtick.color': POSTER['text_dim'],
        'ytick.color': POSTER['text_dim'],
        'grid.color': POSTER['border'],
        'grid.alpha': 0.3,
        'legend.framealpha': 0.9,
        'legend.edgecolor': POSTER['border'],
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
    if len(sys.argv) < 2:
        print("Usage: python3 plot_scaling.py <scaling_output_dir>")
        sys.exit(1)

    scaling_dir = sys.argv[1]
    csv_path = os.path.join(scaling_dir, 'scaling_summary.csv')
    pdf_path = os.path.join(scaling_dir, 'scaling_report.pdf')

    if not os.path.exists(csv_path):
        print(f"Error: {csv_path} not found")
        sys.exit(1)

    rows = read_csv(csv_path)
    if not rows:
        print("Error: no data rows in CSV")
        sys.exit(1)

    # Parse data
    nodes = []
    crawl_latency = []
    index_latency = []
    total_latency = []
    crawl_throughput = []
    index_throughput = []
    query_throughput = []

    for row in rows:
        n = int(row['nodes'])
        nodes.append(n)

        # Latency: per-item latency in ms
        crawl_latency.append(float(row['crawl_latency_ms']) if row['crawl_latency_ms'] else 0)
        index_latency.append(float(row['index_latency_ms']) if row['index_latency_ms'] else 0)
        # End-to-end: total duration in seconds
        total_ms = float(row['total_duration_ms']) if row['total_duration_ms'] else 0
        total_latency.append(total_ms / 1000.0)

        # Throughput: items/sec
        crawl_throughput.append(float(row['crawl_throughput']) if row['crawl_throughput'] else 0)
        index_throughput.append(float(row['index_throughput']) if row['index_throughput'] else 0)
        query_throughput.append(float(row['query_throughput']) if row['query_throughput'] else 0)

    nodes = np.array(nodes)
    setup_style()

    with PdfPages(pdf_path) as pdf:
        # ─── Page 1: Latency vs Node Count ───
        fig, ax = plt.subplots(figsize=(11, 7))
        fig.set_facecolor(POSTER['bg'])

        ax.plot(nodes, crawl_latency, color=LINE_COLORS[0],
                marker='^', markersize=9, linewidth=2, label='Crawler (ms/page)')
        ax.plot(nodes, index_latency, color=LINE_COLORS[1],
                marker='^', markersize=9, linewidth=2, label='Indexer (ms/doc)')
        ax.plot(nodes, total_latency, color=LINE_COLORS[2],
                marker='^', markersize=9, linewidth=2, label='End-to-End (seconds)')

        ax.set_xticks(nodes)
        style_ax(ax, 'Latency vs. Node Count', 'Number of Nodes', 'Latency')
        plt.tight_layout()
        pdf.savefig(fig)
        plt.close(fig)

        # ─── Page 2: Throughput vs Node Count ───
        fig, ax = plt.subplots(figsize=(11, 7))
        fig.set_facecolor(POSTER['bg'])

        ax.plot(nodes, crawl_throughput, color=LINE_COLORS[0],
                marker='^', markersize=9, linewidth=2, label='Crawler (pages/sec)')
        ax.plot(nodes, index_throughput, color=LINE_COLORS[1],
                marker='^', markersize=9, linewidth=2, label='Indexer (docs/sec)')
        ax.plot(nodes, query_throughput, color=LINE_COLORS[2],
                marker='^', markersize=9, linewidth=2, label='Query (queries/sec)')

        ax.set_xticks(nodes)
        style_ax(ax, 'Throughput vs. Node Count', 'Number of Nodes', 'Throughput (items/sec)')
        plt.tight_layout()
        pdf.savefig(fig)
        plt.close(fig)

    print(f"Scaling report saved to {pdf_path}")


if __name__ == '__main__':
    main()
