'use strict';

/**
 * 坐标工具函数。
 * 箱子坐标统一使用 `x,y,z` 字符串作为 Map 键，避免对象引用比较问题。
 */

/** 将坐标转为字符串键，如 (120,64,200) -> "120,64,200" */
function keyOf(x, y, z) {
  return `${x},${y},${z}`;
}

/** 两个坐标是否相等（容忍整数/浮点） */
function eq(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z;
}

/** 把 {x,y,z} 归一化成整数坐标对象 */
function normalize(pos) {
  return {
    x: Math.floor(Number(pos.x)),
    y: Math.floor(Number(pos.y)),
    z: Math.floor(Number(pos.z))
  };
}

/** 距离（欧几里得） */
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

module.exports = { keyOf, eq, normalize, distance };
