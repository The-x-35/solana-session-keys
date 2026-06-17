import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#0a0a0f",
        panel: "#14141c",
        edge: "#26263400",
      },
    },
  },
  plugins: [],
};

export default config;
