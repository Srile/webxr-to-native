// math.js — mat4 / quat helpers over plain typed arrays (Float32Array out,
// Float32Array or Float64Array in). Column-major, gl-matrix conventions, no
// dependencies and no allocation: every function writes into an `out` the
// caller owns. Record readers take (array, offset) so a pose can be read
// straight out of the native frame / input record.

export function mat4Identity(o) {
  o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0
  o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0
  o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0
  o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1
  return o
}

export function mat4Copy(o, a) {
  for (let i = 0; i < 16; i++) o[i] = a[i]
  return o
}

// Rigid transform from a position at a[p..p+2] and a unit quaternion xyzw at
// a[q..q+3].
export function mat4FromPoseAt(o, a, p, q) {
  return mat4FromRotationTranslation(o, a[q], a[q + 1], a[q + 2], a[q + 3], a[p], a[p + 1], a[p + 2])
}

export function mat4FromRotationTranslation(o, x, y, z, w, px, py, pz) {
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0
  o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0
  o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0
  o[12] = px; o[13] = py; o[14] = pz; o[15] = 1
  return o
}

// o = a × b. Safe when o aliases a or b (a is read into locals first, b per
// column before that column of o is written).
export function mat4Multiply(o, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3]
  o[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  o[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  o[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  o[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7]
  o[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  o[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  o[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  o[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11]
  o[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  o[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  o[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  o[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15]
  o[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  o[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  o[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  o[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  return o
}

// General inverse; returns false (o untouched) when singular.
export function mat4Invert(o, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return false
  det = 1 / det
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return true
}

// Unit quaternion xyzw out of a rigid (unscaled) matrix.
export function mat4GetRotation(o, m) {
  const trace = m[0] + m[5] + m[10]
  let S
  if (trace > 0) {
    S = Math.sqrt(trace + 1) * 2
    o[3] = 0.25 * S
    o[0] = (m[6] - m[9]) / S
    o[1] = (m[8] - m[2]) / S
    o[2] = (m[1] - m[4]) / S
  } else if (m[0] > m[5] && m[0] > m[10]) {
    S = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2
    o[3] = (m[6] - m[9]) / S
    o[0] = 0.25 * S
    o[1] = (m[1] + m[4]) / S
    o[2] = (m[8] + m[2]) / S
  } else if (m[5] > m[10]) {
    S = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2
    o[3] = (m[8] - m[2]) / S
    o[0] = (m[1] + m[4]) / S
    o[1] = 0.25 * S
    o[2] = (m[6] + m[9]) / S
  } else {
    S = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2
    o[3] = (m[1] - m[4]) / S
    o[0] = (m[8] + m[2]) / S
    o[1] = (m[6] + m[9]) / S
    o[2] = 0.25 * S
  }
  return o
}

export function quatNormalize(o, x, y, z, w) {
  let l = x * x + y * y + z * z + w * w
  if (l > 0) { l = 1 / Math.sqrt(l); x *= l; y *= l; z *= l; w *= l } else { x = 0; y = 0; z = 0; w = 1 }
  o[0] = x; o[1] = y; o[2] = z; o[3] = w
  return o
}

// OpenXR asymmetric-fov projection (angles in radians, left/down negative),
// column-major, GL clip space (z in [-1, 1]).
export function mat4Perspective(o, angleLeft, angleRight, angleUp, angleDown, near, far) {
  const tanL = Math.tan(angleLeft), tanR = Math.tan(angleRight)
  const tanU = Math.tan(angleUp), tanD = Math.tan(angleDown)
  const w = tanR - tanL, h = tanU - tanD
  o[0] = 2 / w; o[1] = 0; o[2] = 0; o[3] = 0
  o[4] = 0; o[5] = 2 / h; o[6] = 0; o[7] = 0
  o[8] = (tanR + tanL) / w; o[9] = (tanU + tanD) / h; o[11] = -1
  if (far === Infinity) {
    o[10] = -1; o[14] = -2 * near
  } else {
    const d = far - near
    o[10] = -(far + near) / d; o[14] = -2 * far * near / d
  }
  o[12] = 0; o[13] = 0; o[15] = 0
  return o
}
