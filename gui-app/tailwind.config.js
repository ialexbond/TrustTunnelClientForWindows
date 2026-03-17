/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          50: "#f0f4ff",
          100: "#e0e8ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#1e1b4b",
          800: "#151233",
          900: "#0c0a20",
          950: "#06050f",
        },
      },
    },
  },
  plugins: [],
};
