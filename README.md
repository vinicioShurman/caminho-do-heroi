# Caminho do Herói — Mortal Shell II

Site estático (GitHub Pages) que mostra no mapa do jogo o caminho gravado pelo mod
**HeroPath**, com linha do tempo para avançar e voltar.

## Atualizar depois de jogar

```bash
python tools/build.py
git add data/path.json
git commit -m "Atualiza caminho"
git push
```

`tools/build.py` lê `C:\Users\Usuario\Documents\HeroPath\data\caminho.txt` e
`travessias.txt` e gera `data/path.json`. Para usar outra pasta: `--heropath <pasta>`.

Os tiles do mapa (`tiles/`) só precisam ser gerados uma vez (precisa do Pillow):

```bash
python tools/build.py --tiles
```

Usa `T_UI_Map_Full_NoFog.png` (8192 px) exportado do jogo; outro arquivo: `--mapa <png>`.

## Como funciona

- Conversão mundo → mapa igual à do mod (`originX/originY/scale` do `BP_WorldMapSettings_2D`).
- Pontos fora do mapa (masmorras e interiores) não aparecem; o tempo passa e o site mostra
  "Em interior ou masmorra".
- O tempo de jogo é estimado: cada trecho dura até o próximo começar, mas pausas longas
  (jogo fechado, menu, AFK) são cortadas.
- Arremessos (vários passos rápidos seguidos, ou salto entre pontos de travessia) ficam
  pontilhados; teletransportes e mortes quebram a linha, como no mod.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub e faça `git push` desta pasta.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, pasta `/ (root)`.

## Rodar localmente

```bash
python -m http.server 8137
```

Depois abra http://localhost:8137.

Teclas: espaço reproduz/pausa, ←/→ anda 1 min (Shift: 10 min). O link guarda a posição (`#t=`).
