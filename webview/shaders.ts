// GLSL for the two signature looks: a Fresnel rim so node silhouettes glow into
// the bloom pass, and a travelling energy band along the spawn wires.

export const rimVertex = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewDir;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

export const rimFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vNormalV;
varying vec3 vViewDir;
void main() {
  float rim = 1.0 - max(dot(vNormalV, vViewDir), 0.0);
  rim = pow(rim, 2.2);
  float glow = 0.10 + rim * uIntensity;
  gl_FragColor = vec4(uColor * glow, glow);
}`;

// uv.x runs 0..1 along a TubeGeometry's length, so a moving fract() band reads as
// energy flowing parent→child. No branches — smoothstep keeps it GPU-friendly.
export const wireVertex = /* glsl */ `
varying float vU;
void main() {
  vU = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const wireFragment = /* glsl */ `
uniform float uTime;
uniform vec3 uBase;
uniform vec3 uPulse;
uniform float uSpeed;
uniform float uActivity;
uniform float uDir;
varying float vU;
void main() {
  float band = fract((vU * uDir) - uTime * uSpeed);
  float head = smoothstep(0.0, 0.06, band) * (1.0 - smoothstep(0.10, 0.34, band));
  vec3 col = uBase + uPulse * head * (0.6 + uActivity);
  float glow = 0.22 + head * (1.1 + uActivity);
  gl_FragColor = vec4(col, glow);
}`;
