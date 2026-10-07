# Homebase

Panoul de control al terminalului: starea dispozitivelor din casă, internetul,
notificări și conectare la distanță.

## Structură

| Folder / fișier | Ce face |
|---|---|
| `server/server.py` | Strânge datele (procesor, memorie, internet, dispozitive), caută în rețea, trimite notificări. Rulează ca serviciu: `homebase.service` |
| `server/agent-windows.ps1`, `server/install-windows.ps1` | Programelul de statistici pentru Windows și instalatorul lui. Panoul îl dă PC-ului prin portul 8801 (singurul port deschis în rețea) |
| `server/identify.py` | Ghicește ce e un dispozitiv nou: producătorul plăcii de rețea, numele anunțat (Windows, mDNS, NetBIOS), descrierea DLNA/UPnP și porturile la care răspunde |
| `ui/index.html` | Interfața: tot ce vezi pe ecran |
| `src-tauri/` | Aplicația desktop (Rust + Tauri): fereastra Homebase |
| `dist/index.html` | Nefolosit (Tauri cere un folder `dist`). Aplicația așteaptă serverul și deschide direct http://127.0.0.1:8800 din `src-tauri/src/main.rs` |
| `ui/vendor/` | xterm.js (terminalul din aplicație), copiat din `node_modules` |
| `icon.svg` | Iconița aplicației |

Datele (lista de dispozitive, istoricul) stau în `~/.local/share/homebase/`.

## Comenzi

- Repornește serverul după ce modifici `server.py`: `systemctl --user restart homebase`
- După ce modifici `ui/index.html`: doar reîncarcă fereastra (F5)
- Recompilează aplicația: `npm run build` (rezultatul: `src-tauri/target/release/homebase`)
