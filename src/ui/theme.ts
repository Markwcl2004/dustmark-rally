// Poster colours for the menus. Per environment, picked from public/assets/palettes.json and the concept art
// (docs/art/palettes_preview.jpg): a deep "ink" block colour, a bright accent and a paper tone.
export interface Theme { deep: string; mid: string; accent: string; paper: string; ink: string }

export const BASE: Theme = { deep: '#1d2a33', mid: '#2f6aa3', accent: '#e8b23a', paper: '#f1ece0', ink: '#1b1b1b' };

export const ENV_THEME: Record<string, Theme> = {
  nordic: { deep: '#2e4a3b', mid: '#5f8a8b', accent: '#e8b23a', paper: '#efe5cb', ink: '#18291f' },
  savanna: { deep: '#7a2e22', mid: '#cd5025', accent: '#eab959', paper: '#f4e2c4', ink: '#2a140e' },
  snow: { deep: '#3a3d66', mid: '#9894af', accent: '#e8703a', paper: '#eeecf4', ink: '#1d1e33' },
  coast: { deep: '#1e3a64', mid: '#2b6fa8', accent: '#d9542b', paper: '#f2ead8', ink: '#13233d' },
};

export const themeFor = (art: string | undefined) => (art && ENV_THEME[art]) || BASE;

/** set the CSS custom properties of a screen root */
export function applyTheme(el: HTMLElement, t: Theme) {
  el.style.setProperty('--deep', t.deep);
  el.style.setProperty('--mid', t.mid);
  el.style.setProperty('--accent', t.accent);
  el.style.setProperty('--paper', t.paper);
  el.style.setProperty('--tink', t.ink);
}
