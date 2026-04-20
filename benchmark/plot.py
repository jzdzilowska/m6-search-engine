#!/usr/bin/env python3
"""
Generate benchmark report PDF from CSV data produced by benchmark.js.

Usage:
    python3 benchmark/plot.py <benchmark_output_dir>

Reads:
    <dir>/component_metrics.csv
    <dir>/query_metrics.csv
Produces:
    <dir>/report.pdf   (2 bar charts + summary table)
"""

import sys
import os
import csv
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import matplotlib.gridspec as gridspec
import numpy as np


def read_csv(path):
    """Read CSV into list of dicts."""
    with open(path, newline='') as f:
        return list(csv.DictReader(f))


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 plot.py <benchmark_output_dir>")
        sys.exit(1)

    out_dir = sys.argv[1]
    comp_path = os.path.join(out_dir, 'component_metrics.csv')
    query_path = os.path.join(out_dir, 'query_metrics.csv')
    sys_path = os.path.join(out_dir, 'system_metrics.csv')
    json_path = os.path.join(out_dir, 'results.json')
    pdf_path = os.path.join(out_dir, 'report.pdf')

    if not os.path.exists(comp_path):
        print(f"Error: {comp_path} not found")
        sys.exit(1)

    comp_rows = read_csv(comp_path)
    query_rows = read_csv(query_path) if os.path.exists(query_path) else []
    sys_rows = read_csv(sys_path) if os.path.exists(sys_path) else []

    # Load JSON for extra config info
    config = {}
    if os.path.exists(json_path):
        with open(json_path) as f:
            data = json.load(f)
            config = data.get('config', {})

    # ── Parse component data ──
    latency_labels = []
    latency_values = []
    throughput_labels = []
    throughput_values = []
    table_rows = []  # (component, duration_sec)

    for row in comp_rows:
        comp = row['component']
        dur_ms = float(row['duration_ms']) if row['duration_ms'] else 0
        lat_ms = float(row['latency_ms']) if row['latency_ms'] else 0
        thr = float(row['throughput']) if row['throughput'] else 0
        thr_unit = row.get('throughput_unit', '')

        table_rows.append((comp, f"{dur_ms / 1000:.3f}"))

        if row['latency_ms'] and comp != 'End-to-End':
            latency_labels.append(comp)
            latency_values.append(lat_ms)

        if row['throughput']:
            throughput_labels.append(f"{comp}\n({thr_unit})")
            throughput_values.append(thr)

    # ── Color palette ──
    colors = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2']

    # ── Build PDF with 3 pages: 2 charts + table ──
    with PdfPages(pdf_path) as pdf:
        # ─── Page 1: Latency bar chart ───
        fig, ax = plt.subplots(figsize=(11, 6))
        x = np.arange(len(latency_labels))
        bars = ax.bar(x, latency_values,
                      color=[colors[i % len(colors)] for i in range(len(x))],
                      edgecolor='white', linewidth=0.5)
        ax.set_xticks(x)
        ax.set_xticklabels(latency_labels, fontsize=11)
        ax.set_ylabel('Latency (ms)', fontsize=12)
        ax.set_xlabel('Component', fontsize=12)
        ax.set_title('Latency by Component', fontsize=14, fontweight='bold')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        # Value labels on bars
        for bar, val in zip(bars, latency_values):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                    f'{val:.1f}', ha='center', va='bottom', fontsize=9)
        plt.tight_layout()
        pdf.savefig(fig)
        plt.close(fig)

        # ─── Page 2: Throughput bar chart ───
        if throughput_values:
            fig, ax = plt.subplots(figsize=(11, 6))
            x = np.arange(len(throughput_labels))
            bars = ax.bar(x, throughput_values,
                          color=[colors[i % len(colors)] for i in range(len(x))],
                          edgecolor='white', linewidth=0.5)
            ax.set_xticks(x)
            ax.set_xticklabels(throughput_labels, fontsize=10)
            ax.set_ylabel('Throughput (items/sec)', fontsize=12)
            ax.set_xlabel('Component', fontsize=12)
            ax.set_title('Throughput by Component', fontsize=14, fontweight='bold')
            ax.spines['top'].set_visible(False)
            ax.spines['right'].set_visible(False)
            for bar, val in zip(bars, throughput_values):
                ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                        f'{val:.2f}', ha='center', va='bottom', fontsize=9)
            plt.tight_layout()
            pdf.savefig(fig)
            plt.close(fig)

        # Config footnote text (reused across pages)
        cfg_text = (
            f"Nodes: {config.get('numNodes', '?')} | "
            f"Max pages: {config.get('maxPages', '?')} | "
            f"Query runs: {config.get('queryRuns', '?')} "
            f"(warmup: {config.get('warmupQueries', '?')})"
        )

        def add_footnote(fig):
            fig.text(0.05, 0.02, cfg_text, fontsize=9, color='#888')
            fig.text(0.95, 0.02, config.get('timestamp', ''),
                     fontsize=9, color='#888', ha='right')

        def style_table(tbl):
            tbl.auto_set_font_size(False)
            tbl.set_fontsize(11)
            tbl.scale(1, 1.5)
            for (r, c), cell in tbl.get_celld().items():
                if r == 0:
                    cell.set_facecolor('#f5f5f5')
                    cell.set_text_props(fontweight='bold')
                cell.set_edgecolor('#ddd')

        # ─── Page 3: Duration summary table ───
        row_height = 0.45
        fig_h = max(4, 1.5 + (len(table_rows) + 1) * row_height)
        fig = plt.figure(figsize=(11, fig_h))
        ax1 = fig.add_subplot(111)
        ax1.axis('off')
        ax1.set_title('Duration Summary (seconds)', fontsize=14,
                       fontweight='bold', pad=12, loc='left')
        tbl1 = ax1.table(cellText=table_rows,
                         colLabels=['Component', 'Duration (s)'],
                         cellLoc='left', loc='upper center',
                         colWidths=[0.5, 0.3])
        style_table(tbl1)
        add_footnote(fig)
        plt.tight_layout(rect=[0, 0.05, 1, 1])
        pdf.savefig(fig)
        plt.close(fig)

        # ─── Page 4: Per-query latency table ───
        if query_rows:
            q_col_labels = ['Query', 'Avg (ms)', 'Min (ms)', 'Max (ms)', 'Runs']
            q_data = []
            for qr in query_rows:
                q_data.append([
                    qr['query'],
                    qr['avg_latency_ms'],
                    qr['min_latency_ms'],
                    qr['max_latency_ms'],
                    qr['runs'],
                ])
            fig_h = max(4, 1.5 + (len(q_data) + 1) * row_height)
            fig = plt.figure(figsize=(11, fig_h))
            ax2 = fig.add_subplot(111)
            ax2.axis('off')
            ax2.set_title('Query Latency Breakdown', fontsize=14,
                           fontweight='bold', pad=12, loc='left')
            tbl2 = ax2.table(cellText=q_data, colLabels=q_col_labels,
                             cellLoc='left', loc='upper center',
                             colWidths=[0.3, 0.15, 0.15, 0.15, 0.1])
            style_table(tbl2)
            add_footnote(fig)
            plt.tight_layout(rect=[0, 0.05, 1, 1])
            pdf.savefig(fig)
            plt.close(fig)

        # ─── System / Control Panel metrics ───
        if sys_rows:
            def fmt_bytes(b):
                b = float(b)
                if b < 1024:
                    return f"{int(b)} B"
                if b < 1024 * 1024:
                    return f"{b / 1024:.1f} KB"
                return f"{b / (1024 * 1024):.2f} MB"

            overview = []
            node_rows = []
            for row in sys_rows:
                metric = row['metric']
                val = row['value']
                unit = row.get('unit', '')
                if unit == 'bytes':
                    display = fmt_bytes(val)
                else:
                    display = f"{val} {unit}".strip()
                if metric.startswith('Node '):
                    node_rows.append((metric, display))
                else:
                    overview.append((metric, display))

            # Overview page
            fig_h = max(4, 1.5 + (len(overview) + 1) * row_height)
            fig = plt.figure(figsize=(11, fig_h))
            ax = fig.add_subplot(111)
            ax.axis('off')
            ax.set_title('System Control Panel', fontsize=14,
                         fontweight='bold', pad=12, loc='left')
            tbl = ax.table(cellText=overview,
                           colLabels=['Metric', 'Value'],
                           cellLoc='left', loc='upper center',
                           colWidths=[0.5, 0.35])
            style_table(tbl)
            add_footnote(fig)
            plt.tight_layout(rect=[0, 0.05, 1, 1])
            pdf.savefig(fig)
            plt.close(fig)

            # Per-node page
            if node_rows:
                fig_h = max(4, 1.5 + (len(node_rows) + 1) * row_height)
                fig = plt.figure(figsize=(11, fig_h))
                ax2 = fig.add_subplot(111)
                ax2.axis('off')
                ax2.set_title('Per-Node Data Distribution', fontsize=14,
                              fontweight='bold', pad=12, loc='left')
                tbl2 = ax2.table(cellText=node_rows,
                                 colLabels=['Node', 'Value'],
                                 cellLoc='left', loc='upper center',
                                 colWidths=[0.5, 0.35])
                style_table(tbl2)
                add_footnote(fig)
                plt.tight_layout(rect=[0, 0.05, 1, 1])
                pdf.savefig(fig)
                plt.close(fig)

    print(f"PDF report saved to {pdf_path}")


if __name__ == '__main__':
    main()
