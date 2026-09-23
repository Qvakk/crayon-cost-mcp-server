// Chart.js imports - these require canvas dependencies
// Install works automatically in Docker (Alpine Linux)
// For Windows dev, use Docker or install Visual Studio Build Tools
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration } from 'chart.js';
import { getCurrentLocale } from './localization.js';

/**
 * Chart Generator Utility
 * Generates charts using Chart.js and returns them as base64 data URLs for embedding in chat
 *
 * Note: Requires canvas dependencies. Works automatically in Docker.
 */
class ChartGenerator {
  private chartJSNodeCanvas: ChartJSNodeCanvas | null = null;
  private readonly width: number;
  private readonly height: number;
  private locale = getCurrentLocale();

  // Localized strings. Keys not referenced by any chart are omitted.
  private labels = {
    en: {
      timePeriod: 'Time Period',
      amount: 'Amount',
      cost: 'Cost',
    },
    no: {
      timePeriod: 'Tidsperiode',
      amount: 'Beløp',
      cost: 'Kostnad',
    }
  };

  constructor(width: number = 800, height: number = 600) {
    this.width = width;
    this.height = height;
  }

  /**
   * Lazily constructs the canvas renderer.
   *
   * `new ChartJSNodeCanvas` costs ~800 ms (it compiles Chart.js and registers
   * font providers), and only two of this server's 31 tools draw charts. Building
   * it at module scope paid that on every cold start; deferring it keeps the
   * remaining 29 tools' first call fast.
   */
  private canvas(): ChartJSNodeCanvas {
    if (this.chartJSNodeCanvas === null) {
      this.chartJSNodeCanvas = new ChartJSNodeCanvas({
        width: this.width,
        height: this.height,
        backgroundColour: 'white',
        chartCallback: (ChartJS) => {
          ChartJS.defaults.font.family = 'DejaVu Sans, Liberation Sans, sans-serif';
        }
      });
    }
    return this.chartJSNodeCanvas;
  }

  private getLabel(key: keyof typeof this.labels.en): string {
    return this.labels[this.locale][key];
  }

  /**
   * Generate a pie chart showing distribution
   */
  async generatePieChart(
    labels: string[], 
    values: number[], 
    title: string,
    currency: string = 'NOK'
  ): Promise<string> {
    const config: ChartConfiguration = {
      type: 'pie',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: this.getColorPalette(values.length),
          borderColor: '#ffffff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: title,
            font: { size: 18, weight: 'bold' }
          },
          legend: {
            position: 'right',
            labels: {
              font: { size: 12 },
              generateLabels: (chart) => {
                const data = chart.data;
                if (data.labels && data.datasets.length) {
                  return data.labels.map((label, i) => {
                    const value = data.datasets[0].data[i] as number;
                    const total = (data.datasets[0].data as number[]).reduce((a, b) => a + b, 0);
                    const percentage = ((value / total) * 100).toFixed(1);
                    return {
                      text: `${label}: ${currency} ${value.toLocaleString()} (${percentage}%)`,
                      fillStyle: (data.datasets[0].backgroundColor as string[])[i],
                      hidden: false,
                      index: i
                    };
                  });
                }
                return [];
              }
            }
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed;
                const total = (context.dataset.data as number[]).reduce((a, b) => a + b, 0);
                const percentage = ((value / total) * 100).toFixed(1);
                return `${context.label}: ${currency} ${value.toLocaleString()} (${percentage}%)`;
              }
            }
          }
        }
      }
    };

    return this.renderChart(config);
  }

  /**
   * Generate a doughnut chart (pie chart with hole in center)
   */
  async generateDoughnutChart(
    labels: string[], 
    values: number[], 
    title: string,
    currency: string = 'NOK'
  ): Promise<string> {
    const config: ChartConfiguration = {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: this.getColorPalette(values.length),
          borderColor: '#ffffff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: title,
            font: { size: 18, weight: 'bold' }
          },
          legend: {
            position: 'right',
            labels: { font: { size: 12 } }
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed;
                const total = (context.dataset.data as number[]).reduce((a, b) => a + b, 0);
                const percentage = ((value / total) * 100).toFixed(1);
                return `${context.label}: ${currency} ${value.toLocaleString()} (${percentage}%)`;
              }
            }
          }
        }
      }
    };

    return this.renderChart(config);
  }


  /**
   * Generate a line chart for trends over time
   */
  async generateLineChart(
    labels: string[], 
    datasets: Array<{ label: string; data: number[]; borderColor?: string }>,
    title: string,
    yAxisLabel?: string
  ): Promise<string> {
    const yLabel = yAxisLabel || this.getLabel('cost');
    const config: ChartConfiguration = {
      type: 'line',
      data: {
        labels,
        datasets: datasets.map((ds, idx) => ({
          label: ds.label,
          data: ds.data,
          borderColor: ds.borderColor || this.getColorPalette(datasets.length)[idx],
          backgroundColor: (ds.borderColor || this.getColorPalette(datasets.length)[idx]).replace('1)', '0.2)'),
          borderWidth: 2,
          tension: 0.4,
          fill: true
        }))
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: title,
            font: { size: 18, weight: 'bold' }
          },
          legend: {
            display: true,
            position: 'top',
            labels: { font: { size: 12 } }
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed.y ?? 0;
                return `${context.dataset.label}: ${value.toLocaleString()}`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: false,
            title: {
              display: true,
              text: yLabel,
              font: { size: 14 }
            },
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          },
          x: {
            title: {
              display: true,
              text: this.getLabel('timePeriod'),
              font: { size: 14 }
            }
          }
        }
      }
    };

    return this.renderChart(config);
  }



  /**
   * Render chart configuration and return as base64 data URL
   */
  private async renderChart(config: ChartConfiguration): Promise<string> {
    const imageBuffer = await this.canvas().renderToBuffer(config as any);
    const base64Image = imageBuffer.toString('base64');
    return `data:image/png;base64,${base64Image}`;
  }

  /**
   * Get a color palette for charts
   */
  private getColorPalette(count: number): string[] {
    const colors = [
      'rgba(255, 99, 132, 1)',   // Red
      'rgba(54, 162, 235, 1)',   // Blue
      'rgba(255, 206, 86, 1)',   // Yellow
      'rgba(75, 192, 192, 1)',   // Teal
      'rgba(153, 102, 255, 1)',  // Purple
      'rgba(255, 159, 64, 1)',   // Orange
      'rgba(199, 199, 199, 1)',  // Gray
      'rgba(83, 102, 255, 1)',   // Indigo
      'rgba(255, 102, 204, 1)',  // Pink
      'rgba(102, 255, 178, 1)',  // Mint
      'rgba(255, 178, 102, 1)',  // Peach
      'rgba(178, 102, 255, 1)',  // Lavender
    ];
    
    // Repeat colors if needed
    const result = [];
    for (let i = 0; i < count; i++) {
      result.push(colors[i % colors.length]);
    }
    return result;
  }
}

// Export a singleton instance
export const chartGenerator = new ChartGenerator();
