"""
Gera os dados do site a partir dos arquivos do mod HeroPath.

    python tools/build.py            # só os dados (data/path.json)
    python tools/build.py --tiles    # dados + recorta os tiles do mapa (só precisa uma vez)

Caminhos padrão podem ser trocados com --heropath e --mapa.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEROPATH = r"C:\Users\Usuario\Documents\HeroPath"
MAPA = (r"C:\Users\Usuario\Downloads\Output\Exports\MortalShell2\Content\Sparta"
        r"\UI\World\Map\Textures\T_UI_Map_Full_NoFog.png")

# conversão mundo -> mapa, igual ao Scripts/main.lua do mod (mapa de 4096 px)
ORIGIN_X = 38050.053612
ORIGIN_Y = -134391.872342
SCALE_4096 = 4096 / 315552
MAP_PX = 8192                      # o site usa a textura de 8192 px
SCALE = SCALE_4096 * MAP_PX / 4096
WORLD_TAG = "Core_World"

# mesmos limites do mod para decidir linha normal / pontilhado / quebra
BREAK_DIST = 1600.0
FAST_STEP = 1000.0
TRAV_RADIUS = 1500.0
MAX_THROW = 14000.0   # maior arremesso entre travessias é ~10600

# estimativa de tempo: cada trecho dura até o próximo começar, mas uma pausa longa
# (jogo fechado, menu, AFK) é cortada para no máximo SEC_PER_POINT_CAP por ponto
SEC_PER_POINT_CAP = 6.0
SEC_EXTRA_CAP = 120.0

TILE = 256
MAX_ZOOM = int(math.log2(MAP_PX // TILE))  # 5


def to_map(x, y):
    return MAP_PX / 2 - (x - ORIGIN_X) * SCALE, MAP_PX / 2 - (y - ORIGIN_Y) * SCALE


def read_trechos(path):
    trechos = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("TRECHO"):
                parts = line.split()
                level = parts[1]
                when = dt.datetime.fromisoformat(parts[2] + " " + parts[3])
                trechos.append({"level": level, "start": when, "pts": []})
            elif trechos:
                try:
                    x, y, z = (float(v) for v in line.split(",")[:3])
                except ValueError:
                    continue
                trechos[-1]["pts"].append((x, y, z))
    return trechos


def read_trav(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                x, y = (float(v) for v in line.strip().split(",")[:2])
                out.append((x, y))
            except ValueError:
                pass
    return out


def trecho_marks(pts, prev, near_trav):
    """Como o mod: passos rápidos seguidos = arremesso (pontilhado); um passo rápido só
    = rolamento se curto, arremesso se entre travessias, senão teletransporte (quebra)."""
    n = len(pts)
    marks = [0] * n
    fast = [False] * n
    for k in range(1, n):
        fast[k] = math.dist(pts[k - 1], pts[k]) > FAST_STEP
    def throw(a, b):
        # um salto só entre travessias; longe demais é viagem rápida, não arremesso
        return (math.hypot(b[0] - a[0], b[1] - a[1]) <= MAX_THROW
                and near_trav(a) and near_trav(b))

    # primeiro ponto: novo trecho; só liga (pontilhado) se o salto foi um arremesso
    marks[0] = 2 if prev is not None and throw(prev, pts[0]) else 1
    k = 1
    while k < n:
        if not fast[k]:
            k += 1
            continue
        j = k
        while j + 1 < n and fast[j + 1]:
            j += 1
        if j > k:
            mode = 2
        else:
            a, b = pts[k - 1], pts[k]
            if math.hypot(b[0] - a[0], b[1] - a[1]) <= BREAK_DIST:
                mode = 0
            elif throw(a, b):
                mode = 2
            else:
                mode = 1
        for i in range(k, j + 1):
            marks[i] = mode
        k = j + 1
    return marks


def build_data(heropath):
    trechos = read_trechos(os.path.join(heropath, "data", "caminho.txt"))
    trav = read_trav(os.path.join(heropath, "data", "travessias.txt"))

    def near_trav(p):
        return any(math.hypot(p[0] - t[0], p[1] - t[1]) <= TRAV_RADIUS for t in trav)

    # duração estimada de cada trecho (menu principal fica de fora)
    for i, tr in enumerate(trechos):
        n = len(tr["pts"])
        gap = (trechos[i + 1]["start"] - tr["start"]).total_seconds() if i + 1 < len(trechos) else n * 2.0
        tr["dur"] = max(0.5, min(gap, n * SEC_PER_POINT_CAP + SEC_EXTRA_CAP)) if n else 0.0
        tr["menu"] = "/Menu/" in tr["level"]

    # pontos com tempo de jogo; marca = 0 liga ao anterior, 1 quebra, 2 pontilhado
    xs, ys, ts, ms = [], [], [], []
    sessions = []
    clock = 0.0
    prev = None           # ponto anterior do mundo (coords do mundo + z)
    for tr in trechos:
        if tr["menu"] or not tr["pts"]:
            continue
        in_world = WORLD_TAG in tr["level"]
        sessions.append({
            "t": round(clock, 1),
            "date": tr["start"].strftime("%Y-%m-%d %H:%M:%S"),
            "level": tr["level"].split("/")[-1],
            "world": in_world,
            "i": len(xs),
        })
        pts = tr["pts"]
        n = len(pts)
        step_t = tr["dur"] / n
        if not in_world:
            prev = None
            clock += tr["dur"]
            continue
        marks = trecho_marks(pts, prev, near_trav)
        for k, p in enumerate(pts):
            mark = marks[k]
            mx, my = to_map(p[0], p[1])
            if not (0 <= mx <= MAP_PX and 0 <= my <= MAP_PX):
                prev = None
                continue
            if prev is None and mark != 1:
                mark = 1
            xs.append(round(mx, 1))
            ys.append(round(my, 1))
            ts.append(round(clock + k * step_t, 1))
            ms.append(mark)
            prev = p
        clock += tr["dur"]

    # distância acumulada (mundo, cm) só nas partes ligadas
    dist = 0.0
    for i in range(1, len(xs)):
        if ms[i] != 1:
            dist += math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) / SCALE

    data = {
        "mapPx": MAP_PX,
        "maxZoom": MAX_ZOOM,
        "total": round(clock, 1),
        "distanceKm": round(dist / 100000, 2),
        "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "sessions": sessions,
        "x": xs, "y": ys, "t": ts, "m": ms,
    }
    out = os.path.join(ROOT, "data", "path.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"{len(xs)} pontos, {len(sessions)} trechos, {clock / 3600:.1f} h de jogo, "
          f"{data['distanceKm']} km -> {out}")


def build_tiles(mapa):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    img = Image.open(mapa).convert("RGB")
    if img.size != (MAP_PX, MAP_PX):
        img = img.resize((MAP_PX, MAP_PX), Image.LANCZOS)
    for z in range(MAX_ZOOM, -1, -1):
        size = TILE * 2 ** z
        level = img if size == MAP_PX else img.resize((size, size), Image.LANCZOS)
        n = 2 ** z
        for tx in range(n):
            d = os.path.join(ROOT, "tiles", str(z), str(tx))
            os.makedirs(d, exist_ok=True)
            for ty in range(n):
                tile = level.crop((tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE))
                tile.save(os.path.join(d, f"{ty}.jpg"), quality=82, optimize=True)
        print(f"zoom {z}: {n * n} tiles")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--heropath", default=HEROPATH)
    ap.add_argument("--mapa", default=MAPA)
    ap.add_argument("--tiles", action="store_true")
    a = ap.parse_args()
    build_data(a.heropath)
    if a.tiles:
        build_tiles(a.mapa)
    sys.exit(0)
