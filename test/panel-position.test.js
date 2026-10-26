import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PROJECT_ROOT } from "../src/constants.js";

const injectSource = readFileSync(`${PROJECT_ROOT}/src/ui/inject.js`, "utf8");

test("the anchor icon never overlaps the TRAE title bar", () => {
  // 顶部净空必须存在：优先量 .titlebar 的实际底边，量不到退回固定净空。
  assert.match(injectSource, /function titleBarClearance\(\)/);
  assert.match(injectSource, /querySelector\("\.titlebar"\)/);
  assert.match(injectSource, /TITLEBAR_FALLBACK_CLEARANCE = 40/);
  // clampFabTop 的下限必须是标题栏净空，而不是 0。
  const clamp = injectSource.match(/function clampFabTop\(top\) \{[\s\S]*?\n  \}/);
  assert.ok(clamp, "clampFabTop must exist");
  assert.match(clamp[0], /Math\.max\(minTop, top\)/);
  assert.doesNotMatch(clamp[0], /Math\.max\(0, top\)/);
});

test("the anchor icon drags vertically only and stays pinned to the right edge", () => {
  // 拖拽只应用纵向位移：pointermove 里不允许再用 clientX 计算位置。
  const drag = injectSource.match(/function wireDrag\(handle\) \{[\s\S]*?\n  \}/);
  assert.ok(drag, "wireDrag must exist");
  assert.match(drag[0], /moveWidget\(dragState\.top \+ dy\)/);
  assert.doesNotMatch(drag[0], /dragState\.left \+ dx/);
  assert.doesNotMatch(drag[0], /clientX/);
  // moveWidget 横向钉死右缘，left 恒为 auto。
  const move = injectSource.match(/function moveWidget\(top\) \{[\s\S]*?\n  \}/);
  assert.ok(move, "moveWidget must exist");
  assert.match(move[0], /right = `\$\{FAB_RIGHT_OFFSET\}px`/);
  assert.match(move[0], /left = "auto"/);
  // 记忆的位置只有纵向：旧版 {left, top} 中的横向半边作废。
  assert.match(injectSource, /JSON\.stringify\(\{ top: next \}\)/);
  assert.match(injectSource, /Number\.isFinite\(saved\?\.top\) \? \{ top: saved\.top \} : null/);
});
