import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0f1117",
          1: "#161b27",
          2: "#1e2433",
          3: "#252d3d",
        },
        accent: {
          blue: "#4f6ef7",
          purple: "#8b5cf6",
          green: "#10b981",
          amber: "#f59e0b",
          pink: "#ec4899",
          cyan: "#06b6d4",
        },
      },
    },
  },
  plugins: [],
};

export default config;
