/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    fontSize: {
      xs: "var(--font-size-xs)",
      sm: "var(--font-size-sm)",
      base: "var(--font-size-md)",
      lg: "var(--font-size-lg)",
      xl: "var(--font-size-xl)",
      "2xl": "var(--font-size-2xl)",
      // Display sizes — wordmark / splash / hero-секции. Не для UI-text.
      "3xl": "var(--font-size-3xl)",
      "4xl": "var(--font-size-4xl)",
      "5xl": "var(--font-size-5xl)",
    },
  },
  plugins: [],
};
