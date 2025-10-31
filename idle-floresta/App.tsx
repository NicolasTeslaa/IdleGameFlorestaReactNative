import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, SafeAreaView, StyleSheet, Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Canvas, Rect, Group } from "@shopify/react-native-skia";

// =========================
// Config do jogo
// =========================
const TILE = 16; // tamanho base (pixel art)
const GRID_W = 20; // largura do grid em tiles
const GRID_H = 12; // altura do grid em tiles
const WORLD_W = GRID_W * TILE;
const WORLD_H = GRID_H * TILE;

// Velocidades e taxas
const TICK_MS = 500; // game tick a cada 0.5s (idle-friendly)
const HUNGER_DECAY = 1; // fome por tick
const HEALTH_DECAY = 2; // vida por tick quando fome == 0
const BASE_WOOD_RATE = 1; // madeira por ciclo de coleta

// Custos
const COST_CAMPFIRE = 20;
const COST_HUT = 50;

// =========================
// Tipos
// =========================
type Tree = {
  id: number;
  x: number; // em tiles
  y: number; // em tiles
  hp: number; // vida da árvore
  alive: boolean;
  respawn: number; // ticks até renascer
};

// =========================
// Utils
// =========================
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeTrees(count = 12): Tree[] {
  const trees: Tree[] = [];
  for (let i = 0; i < count; i++) {
    trees.push({
      id: i,
      x: randInt(1, GRID_W - 2),
      y: randInt(2, GRID_H - 2),
      hp: randInt(2, 5),
      alive: true,
      respawn: 0,
    });
  }
  return trees;
}

// Distância Manhattan em tiles
const dist = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) + Math.abs(ay - by);

// =========================
// App (protótipo jogável)
// =========================
export default function App() {
  // Estado "lento" (pode usar React state)
  const [wood, setWood] = useState(0);
  const [hunger, setHunger] = useState(100);
  const [health, setHealth] = useState(100);
  const [hasCampfire, setHasCampfire] = useState(false);
  const [hasHut, setHasHut] = useState(false);
  const [day, setDay] = useState(1);
  const [nightOpacity, setNightOpacity] = useState(0); // 0..~0.6

  // Mundo
  const treesRef = useRef<Tree[]>(makeTrees());
  const playerRef = useRef({ x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) });
  const worldTicks = useRef(0);

  // Persistência simples
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem("idle-forest-save");
        if (saved) {
          const s = JSON.parse(saved);
          setWood(s.wood ?? 0);
          setHunger(s.hunger ?? 100);
          setHealth(s.health ?? 100);
          setHasCampfire(!!s.hasCampfire);
          setHasHut(!!s.hasHut);
          setDay(s.day ?? 1);
          if (s.player) playerRef.current = s.player;
          if (s.trees) treesRef.current = s.trees;
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const to = setInterval(() => {
      AsyncStorage.setItem(
        "idle-forest-save",
        JSON.stringify({
          wood,
          hunger,
          health,
          hasCampfire,
          hasHut,
          day,
          player: playerRef.current,
          trees: treesRef.current,
        })
      ).catch(() => {});
    }, 4000);
    return () => clearInterval(to);
  }, [wood, hunger, health, hasCampfire, hasHut, day]);

  // =========================
  // Ciclo dia/noite sem hooks do Skia
  // =========================
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) % 30000; // 30s = 1 "dia"
      const phase = elapsed / 30000; // 0..1
      const night = Math.max(0, Math.cos(phase * Math.PI * 2));
      let base = 0.25 + 0.35 * night; // 0..~0.6
      if (hasCampfire) base = Math.max(0, base - 0.12);
      setNightOpacity(base);
    }, 200);
    return () => clearInterval(id);
  }, [hasCampfire]);

  // =========================
  // Loop principal (idle)
  // =========================
  useEffect(() => {
    const id = setInterval(() => {
      worldTicks.current += 1;

      // Dia/Noite e contagem de dias
      if (worldTicks.current % Math.round(30000 / TICK_MS) === 0) {
        setDay((d) => d + 1);
      }

      // Fome e vida
      const hungerDrop = hasHut ? HUNGER_DECAY * 0.7 : HUNGER_DECAY;
      setHunger((h) => Math.max(0, h - hungerDrop));
      setHealth((hp) => (hunger - hungerDrop <= 0 ? Math.max(0, hp - HEALTH_DECAY) : Math.min(100, hp + (hasCampfire ? 1 : 0))));

      // Game Over?
      if (health <= 0) {
        Alert.alert("Game Over", "Você desmaiou de fome. Reiniciar?", [
          { text: "Reiniciar", onPress: () => resetGame() },
        ]);
      }

      // Coleta automática
      const trees = treesRef.current;
      const p = playerRef.current;
      let target: Tree | undefined = undefined;
      let best = 999;
      for (const t of trees) {
        if (!t.alive) continue;
        const d = dist(p.x, p.y, t.x, t.y);
        if (d < best) {
          best = d;
          target = t;
        }
      }

      if (target) {
        if (best > 1) {
          const dx = Math.sign(target.x - p.x);
          const dy = Math.sign(target.y - p.y);
          if (Math.abs(target.x - p.x) > Math.abs(target.y - p.y)) p.x += dx; else p.y += dy;
        } else {
          const rate = BASE_WOOD_RATE + (hasCampfire ? 0.5 : 0) + (hasHut ? 0.25 : 0);
          target.hp -= 1;
          setWood((w) => w + rate);
          if (target.hp <= 0) {
            target.alive = false;
            target.respawn = randInt(6, 16);
          }
        }
      }

      // Respawn de árvores
      for (const t of trees) {
        if (!t.alive) {
          t.respawn -= 1;
          if (t.respawn <= 0) {
            t.alive = true;
            t.hp = randInt(2, 5);
            t.x = randInt(1, GRID_W - 2);
            t.y = randInt(2, GRID_H - 2);
          }
        }
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [hasCampfire, hasHut, health, hunger]);

  function resetGame() {
    treesRef.current = makeTrees();
    playerRef.current = { x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) };
    setWood(0);
    setHunger(100);
    setHealth(100);
    setHasCampfire(false);
    setHasHut(false);
    setDay(1);
  }

  function buyCampfire() {
    if (hasCampfire) return;
    if (wood < COST_CAMPFIRE) return;
    setWood((w) => w - COST_CAMPFIRE);
    setHasCampfire(true);
  }

  function buyHut() {
    if (hasHut) return;
    if (wood < COST_HUT) return;
    setWood((w) => w - COST_HUT);
    setHasHut(true);
  }

  // =========================
  // Render (Skia + UI)
  // =========================
  const trees = treesRef.current;
  const player = playerRef.current;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topbar}>
        <Stat label="Dia" value={day} />
        <Stat label="Madeira" value={Math.floor(wood)} />
        <Stat label="Fome" value={`${Math.floor(hunger)}%`} warn={hunger <= 20} />
        <Stat label="Vida" value={`${Math.floor(health)}%`} warn={health <= 30} />
      </View>

      <View style={styles.worldWrap}>
        <Canvas style={{ width: WORLD_W * 2, height: WORLD_H * 2 }}>
          {/* fundo (grama pixelada) */}
          <Group transform={[{ scale: 2 }]}> 
            {Array.from({ length: GRID_W * GRID_H }).map((_, idx) => {
              const x = (idx % GRID_W) * TILE;
              const y = Math.floor(idx / GRID_W) * TILE;
              const shade = ((x / TILE + y / TILE) % 2 === 0) ? "#366c3e" : "#2f5d36";
              return <Rect key={idx} x={x} y={y} width={TILE} height={TILE} color={shade} />;
            })}

            {/* árvores */}
            {trees.map((t) => (
              <Group key={t.id}>
                {t.alive ? (
                  <>
                    {/* tronco */}
                    <Rect x={t.x * TILE} y={t.y * TILE + 6} width={4} height={6} color="#5b3a1e" />
                    {/* copa pixelada */}
                    <Rect x={t.x * TILE - 2} y={t.y * TILE + 2} width={12} height={10} color="#2e7d32" />
                  </>
                ) : null}
              </Group>
            ))}

            {/* fogueira */}
            {hasCampfire ? (
              <Group>
                <Rect x={4 * TILE} y={3 * TILE} width={6} height={2} color="#5b3a1e" />
                <Rect x={4 * TILE + 1} y={3 * TILE - 3} width={4} height={3} color="#ff6f00" />
              </Group>
            ) : null}

            {/* cabana */}
            {hasHut ? (
              <Group>
                <Rect x={2 * TILE} y={2 * TILE} width={TILE} height={TILE} color="#795548" />
                <Rect x={2 * TILE + 4} y={2 * TILE + 6} width={4} height={6} color="#3e2723" />
              </Group>
            ) : null}

            {/* jogador (boneco pixel) */}
            <Group>
              <Rect x={player.x * TILE} y={player.y * TILE} width={TILE} height={TILE} color="#1e88e5" />
              <Rect x={player.x * TILE + 5} y={player.y * TILE + 4} width={2} height={2} color="#fff" />
            </Group>

            {/* overlay de noite */}
            <Rect x={0} y={0} width={WORLD_W} height={WORLD_H} color="black" opacity={nightOpacity} />
          </Group>
        </Canvas>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, wood < COST_CAMPFIRE || hasCampfire ? styles.btnDisabled : null]}
          onPress={buyCampfire}
        >
          <Text style={styles.btnText}>🔥 Fogueira ({COST_CAMPFIRE})</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, wood < COST_HUT || hasHut ? styles.btnDisabled : null]}
          onPress={buyHut}
        >
          <Text style={styles.btnText}>🏚️ Cabana ({COST_HUT})</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnDanger]} onPress={resetGame}>
          <Text style={styles.btnText}>↺ Reiniciar</Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Text style={styles.tip}>Dica: fogueira reduz a escuridão e regenera um pouco de vida à noite.</Text>
      </View>
    </SafeAreaView>
  );
}

// =========================
// UI helpers
// =========================
function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, warn ? { color: "#f44336" } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#10271a" },
  topbar: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 8, backgroundColor: "#153521", borderBottomWidth: 1, borderBottomColor: "#204f33" },
  stat: { alignItems: "center" },
  statLabel: { color: "#9be7c4", fontSize: 12 },
  statValue: { color: "#e0f2f1", fontWeight: "700", fontSize: 14 },
  worldWrap: { alignItems: "center", justifyContent: "center", flex: 1 },
  actions: { flexDirection: "row", gap: 8, justifyContent: "center", paddingVertical: 10, backgroundColor: "#153521" },
  btn: { backgroundColor: "#1b5e20", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8 },
  btnDisabled: { opacity: 0.5 },
  btnDanger: { backgroundColor: "#b71c1c" },
  btnText: { color: "#e8f5e9", fontWeight: "700" },
  footer: { alignItems: "center", paddingBottom: 10 },
  tip: { color: "#c8e6c9", fontSize: 12 },
});