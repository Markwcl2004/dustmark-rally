// Route table: wires the screen factories into the app (kept here so app.ts does not import the screens).
import { app } from '../../app/app';
import { BASE } from '../theme';
import { titleScreen, mainMenu } from './front';
import { garageScreen } from './garage';
import { envSelect } from './stages';
import { careerEntry } from './career';
import { settingsScreen } from './settings';
import { pauseScreen } from './pause';

export function installRoutes() {
  app.go = {
    title: () => void app.show(titleScreen, { theme: BASE }),
    menu: () => void app.show(mainMenu, { theme: BASE }),
    garage: () => void app.show(() => garageScreen({ back: () => app.go.menu() }), { theme: BASE }),
    stageSelect: (mode) => void app.show(() => envSelect(mode), { theme: BASE }),
    career: () => careerEntry(),
    settings: (back, overGame, tab) => {
      if (overGame) app.overlay(settingsScreen(back, true, tab));
      else void app.show(() => settingsScreen(back, false, tab), { theme: BASE });
    },
    pause: (game, hooks) => { pauseScreen(game, hooks); },
  };
}
