/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        yes: '#3fb68b',
        no: '#ff5353',
        info: '#00b2ff',
        main: 'var(--text-main)',
        secondary: 'var(--text-secondary)',
        active: 'var(--bg-active)',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        light: {
          ...require('daisyui/src/theming/themes')['[data-theme=light]'],
          primary: '#005fcc',
          'primary-content': '#ffffff',
          secondary: '#3385ff',
          accent: '#764bc8',
        },
      },
      {
        dark: {
          ...require('daisyui/src/theming/themes')['[data-theme=dark]'],
          primary: '#99ccff',
          'primary-content': '#0a0e27',
          secondary: '#3385ff',
          accent: '#a78bfa',
          'base-100': '#0a0a0f',
          'base-200': '#0d0d14',
          'base-300': '#12121a',
        },
      },
    ],
  },
};
