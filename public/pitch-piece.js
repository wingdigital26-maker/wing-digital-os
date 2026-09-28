import * as THREE from 'three';

function initWingSculpture(container, options={}){
// ---- analytic logo definition (unit square, v down) ----
const MA=0.46, MB=0.54, MR=0.26;
function inside(u,v){
  if(u<0||u>1||v<0||v>1) return false;
  if(u>MA&&v<MB){
    const cx=MA+MR, cy=MB-MR;
    if(!(u<cx&&v>cy&&Math.hypot(u-cx,v-cy)>MR)) return false;
  }
  if(u<1-MA&&v>1-MB){
    const cx=1-MA-MR, cy=1-MB+MR;
    if(!(u>cx&&v<cy&&Math.hypot(u-cx,v-cy)>MR)) return false;
  }
  return true;
}

const qs = new URLSearchParams(location.search);
const getW = ()=> container.clientWidth || window.innerWidth;
const getH = ()=> container.clientHeight || window.innerHeight;
const ASPECT = 63/66;
const isMobile = getW() < 820;
const LOGO_H = 4.1;
const LOGO_W = LOGO_H * ASPECT;
const DEPTH = LOGO_W * 0.28;
const reducedMotion = options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// ?plates= / options.plateDensity: plate-count multiplier (1 = the default desktop count)
const densityParam = parseFloat(qs.get('plates'));
const plateDensity = !isNaN(densityParam) ? densityParam : (options.plateDensity ?? 1.0);

const scene = new THREE.Scene();
const FOV = 32, CAM_D = 13;
const camera = new THREE.PerspectiveCamera(FOV, getW()/getH(), 0.1, 100);
camera.position.set(0,0,CAM_D);

const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
renderer.setSize(getW(), getH());
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping; // ACES drags bright blues toward lavender; Neutral keeps the hue
renderer.toneMappingExposure = options.exposure ?? 1.0;
renderer.domElement.style.opacity = '0';
renderer.domElement.style.transition = 'opacity 0.6s ease';
container.appendChild(renderer.domElement);

// ---------- studio environment: all-cool. A navy gradient dome (so no face ever reflects pure
// black) plus softboxes that are white, steel or Wing blue only. No warm sources anywhere. ----------
const envScene = new THREE.Scene();
const envDisposables = [];
{
  const g = new THREE.SphereGeometry(40, 32, 24);
  const cBot = new THREE.Color('#02040c'), cMid = new THREE.Color('#0a1538'), cTop = new THREE.Color('#1a2a5c');
  const colors = new Float32Array(g.attributes.position.count*3), c = new THREE.Color();
  for(let i=0;i<g.attributes.position.count;i++){
    const t = g.attributes.position.getY(i)/40; // -1..1
    if(t<0) c.copy(cMid).lerp(cBot, Math.min(1,-t*1.6)); else c.copy(cMid).lerp(cTop, t);
    colors.set([c.r,c.g,c.b], i*3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors,3));
  const m = new THREE.MeshBasicMaterial({vertexColors:true, side:THREE.BackSide, toneMapped:false});
  envScene.add(new THREE.Mesh(g,m)); envDisposables.push(g,m);
}
function softbox(w,h,x,y,z,color,intensity){
  const g = new THREE.PlaneGeometry(w,h);
  const mm = new THREE.MeshBasicMaterial({color, toneMapped:false, side:THREE.DoubleSide});
  mm.color.multiplyScalar(intensity);
  const m = new THREE.Mesh(g, mm);
  m.position.set(x,y,z); m.lookAt(0,0,0);
  envScene.add(m); envDisposables.push(g,mm);
}
softbox(8,5,   -7, 7, 8,  0xf1f5ff, 5.0);   // big key softbox, upper-left-front
softbox(3.2,14, 9, 1, 6,  0xffffff, 6.5);  // tall strip right-front: the long travelling highlight
softbox(1.6,14,-9, 0,-5,  0xcfe0ff, 4.0);   // tall strip left-rear: edge catch
softbox(1.6,12, 8, 3,-7,  0x9db8ff, 8.0);   // steel-blue strip right-rear: rim
softbox(14,2.2, 0,10,-1,  0xe6eeff, 3.5);   // overhead strip: top-edge catch
softbox(13,8,   5,-8, 3,  0x2757E6, 3.2);
softbox(16,4.0, 0,-5.0,12, 0xe8efff, 3.6);  // low front band: the face tilts forward, so near face-on it reflects BELOW the camera; this is what it sees
softbox(22,14,  0, 0,16,   0x4668c4, 0.55); // dim steel-blue front fill: camera-facing faces never go dead   // Wing-blue bounce from below
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(envScene, 0.015);
scene.environment = envRT.texture;

const key = new THREE.DirectionalLight(0xf4f7ff, 1.1); key.position.set(-5,7,9); scene.add(key);
const rim = new THREE.DirectionalLight(0x6f95ff, 5.0); rim.position.set(7,3,-7); scene.add(rim);
const rim2 = new THREE.DirectionalLight(0xcfe0ff, 3.0); rim2.position.set(-8,2,-6); scene.add(rim2);

const group = new THREE.Group();
const BASE_TILT_X = THREE.MathUtils.degToRad(10);
group.rotation.x = BASE_TILT_X;
scene.add(group);

// ---------- backdrop glow + contact glow (in-scene so embeds get them too) ----------
function radialTex(stops){
  const c = document.createElement('canvas'); c.width=c.height=256;
  const x = c.getContext('2d'); const g = x.createRadialGradient(128,128,0,128,128,128);
  for(const [o,col] of stops) g.addColorStop(o,col);
  x.fillStyle=g; x.fillRect(0,0,256,256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowTex = radialTex([[0,'rgba(46,84,210,1)'],[0.35,'rgba(30,56,150,0.45)'],[0.7,'rgba(16,30,84,0.12)'],[1,'rgba(10,20,60,0)']]);
const glowMat = new THREE.SpriteMaterial({map:glowTex, transparent:true, opacity:0.2, depthWrite:false, depthTest:false, toneMapped:false});
const glow = new THREE.Sprite(glowMat); glow.renderOrder = -2; scene.add(glow);
const floorMat = new THREE.SpriteMaterial({map:glowTex, transparent:true, opacity:0.34, depthWrite:false, depthTest:false, toneMapped:false});
const floorGlow = new THREE.Sprite(floorMat); floorGlow.renderOrder = -1; scene.add(floorGlow);
if(options.backdropGlow===false){ glow.visible=false; floorGlow.visible=false; }

// ---------- plate records ----------
const sizeMul = (isMobile ? 1.3 : 1.0) / Math.sqrt(plateDensity);
const PITCH_X0 = 0.078*sizeMul, PITCH_Y0 = 0.048*sizeMul;
const SEAM = 0.005;                  // hairline gap between plates, world units
const SZ = 0.03;                     // face-plate thickness
const colsN = Math.round(LOGO_W/PITCH_X0), rowsN = Math.round(LOGO_H/PITCH_Y0);
const PITCH_X = LOGO_W/colsN, PITCH_Y = LOGO_H/rowsN;
const PLATE_W = PITCH_X;

const records = []; // {pos, quat, normal, sx,sy,sz}
const qBack = new THREE.Quaternion().setFromEuler(new THREE.Euler(0,Math.PI,0));
// inside spans of a row, found by fine sampling, so every plate is clipped to the true outline
function rowSpans(v){
  const S=800, spans=[]; let start=-1;
  for(let i=0;i<=S;i++){
    const u=(i+0.5)/S, inn = i<S && inside(u,v);
    if(inn && start<0) start=i/S;
    if(!inn && start>=0){ spans.push([start, i/S]); start=-1; }
  }
  return spans;
}
let frontBackCount = 0;
for(let r=0;r<rowsN;r++){
  const v = (r+0.5)/rowsN;
  const y = LOGO_H/2 - v*LOGO_H;
  const off = (r%2===0)?0:0.5;
  for(const [u0,u1] of rowSpans(v)){
    const xs0 = u0*LOGO_W, xs1 = u1*LOGO_W;
    for(let c=-1;c<=colsN;c++){
      let a = Math.max((c+off)*PITCH_X, xs0), b = Math.min((c+off+1)*PITCH_X, xs1);
      if(b-a < PITCH_X*0.22) continue;
      // absorb a sliver neighbour so edges stay clean
      if(a-xs0 < PITCH_X*0.22) a = xs0;
      if(xs1-b < PITCH_X*0.22) b = xs1;
      const x = -LOGO_W/2 + (a+b)/2;
      const sx = (b-a)-SEAM, sy = PITCH_Y-SEAM;
      records.push({pos:new THREE.Vector3(x,y,DEPTH/2+SZ/2), quat:new THREE.Quaternion(), normal:new THREE.Vector3(0,0,1), sx,sy,sz:SZ});
      records.push({pos:new THREE.Vector3(x,y,-DEPTH/2-SZ/2), quat:qBack.clone(), normal:new THREE.Vector3(0,0,-1), sx,sy,sz:SZ});
      frontBackCount += 2;
    }
  }
}

// side walls: walk the full outline (clockwise in uv)
function outlinePoints(spacingW){
  const pts = [];
  function addSeg(x0,y0,x1,y1){
    const dx=(x1-x0)*LOGO_W, dy=(y1-y0)*LOGO_H, len=Math.hypot(dx,dy);
    const n = Math.max(1, Math.round(len/spacingW));
    const tx=dx/len, ty=dy/len;
    for(let i=0;i<n;i++){ const t=(i+0.5)/n; pts.push({u:x0+(x1-x0)*t, v:y0+(y1-y0)*t, tx, ty, nx:ty, ny:-tx, pitch:len/n}); }
  }
  function addArc(cx,cy,r,a0,a1){
    // r is in u units; the mark is near-square so treat the fillet as circular in world space
    const rw = r*(LOGO_W+LOGO_H)/2;
    const len = Math.abs(a1-a0)*rw;
    const n = Math.max(1, Math.round(len/spacingW));
    const dir=Math.sign(a1-a0);
    for(let i=0;i<n;i++){
      const a=a0+(a1-a0)*(i+0.5)/n;
      const ca=Math.cos(a), sa=Math.sin(a);
      let tx=-sa*dir*LOGO_W, ty=ca*dir*LOGO_H; const tl=Math.hypot(tx,ty); tx/=tl; ty/=tl;
      pts.push({u:cx+r*ca, v:cy+r*sa, tx, ty, nx:ty, ny:-tx, pitch:len/n});
    }
  }
  addSeg(0,0, MA,0);
  addSeg(MA,0, MA,MB-MR);
  addArc(MA+MR, MB-MR, MR, Math.PI, Math.PI/2);
  addSeg(MA+MR,MB, 1,MB);                 // (was missing in v3: top of the lower block showed bare core)
  addSeg(1,MB, 1,1);
  addSeg(1,1, 1-MA,1);
  addSeg(1-MA,1, 1-MA,1-MB+MR);
  addArc(1-MA-MR, 1-MB+MR, MR, 0, -Math.PI/2);
  addSeg(1-MA-MR,1-MB, 0,1-MB);           // (was missing in v3: underside of the upper block)
  addSeg(0,1-MB, 0,0);
  return pts;
}
const SIDE_SZ = 0.03;
const sideStackN = Math.max(4, Math.round(7/sizeMul));
const sideSpan = DEPTH + 2*SZ;
let sideCount = 0;
for(const p of outlinePoints(PLATE_W*1.25)){
  const wx = (p.u-0.5)*LOGO_W, wy = -(p.v-0.5)*LOGO_H;
  const normal3 = new THREE.Vector3(p.nx,-p.ny,0).normalize();
  const tangent3 = new THREE.Vector3(p.tx,-p.ty,0).normalize();
  const yAxis = new THREE.Vector3().crossVectors(normal3, tangent3).normalize();
  const baseQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent3, yAxis, normal3));
  for(let s=0;s<sideStackN;s++){
    const depthOff = -sideSpan/2 + (s+0.5)*(sideSpan/sideStackN);
    const pos = new THREE.Vector3(wx+normal3.x*SIDE_SZ/2, wy+normal3.y*SIDE_SZ/2, depthOff);
    records.push({pos, quat:baseQ.clone(), normal:normal3.clone(), sx:p.pitch-SEAM, sy:sideSpan/sideStackN-SEAM, sz:SIDE_SZ});
    sideCount++;
  }
}
const OUTLINE = outlinePoints(0.12).map(p=>[(p.u-0.5)*LOGO_W, -(p.v-0.5)*LOGO_H]);
let NECK_IDX = 0; { let bd=1e9; OUTLINE.forEach((q,i)=>{ const d=Math.hypot(q[0]-(MA-0.5)*LOGO_W,q[1]-0.5*LOGO_H); if(d<bd){bd=d;NECK_IDX=i;} }); }
window.__plateCounts = {front: frontBackCount/2, back: frontBackCount/2, sides: sideCount, total: records.length};

// ---------- interior: NO solid core. The volume is packed with coarser, thicker fragments in the same
// InstancedMesh (3 layers of chunks through the depth), so at rest the seams show metal, not a void,
// and when it comes apart the inside is fragments too. ----------
const OUTER_N = records.length;
{
  const INNER_LAYERS = 3, IK = 1.75;
  const iCols = Math.max(2, Math.round(colsN/IK)), iRows = Math.max(2, Math.round(rowsN/IK));
  const IPX = LOGO_W/iCols, IPY = LOGO_H/iRows, ISEAM = 0.012;
  const layerT = DEPTH/INNER_LAYERS;
  for(let L=0;L<INNER_LAYERS;L++){
    const z = -DEPTH/2 + (L+0.5)*layerT;
    const nzSign = L===0 ? -1 : 1;
    for(let r=0;r<iRows;r++){
      const v=(r+0.5)/iRows, y=LOGO_H/2 - v*LOGO_H;
      const off = ((r+L)%2===0)?0:0.5;
      for(const [u0,u1] of rowSpans(v)){
        const xs0=u0*LOGO_W, xs1=u1*LOGO_W;
        for(let c=-1;c<=iCols;c++){
          let a=Math.max((c+off)*IPX, xs0), b=Math.min((c+off+1)*IPX, xs1);
          if(b-a < IPX*0.22) continue;
          if(a-xs0 < IPX*0.22) a=xs0;
          if(xs1-b < IPX*0.22) b=xs1;
          records.push({pos:new THREE.Vector3(-LOGO_W/2+(a+b)/2, y, z), quat:(nzSign<0?qBack.clone():new THREE.Quaternion()), normal:new THREE.Vector3(0,0,nzSign), sx:(b-a)-ISEAM, sy:IPY-ISEAM, sz:layerT-ISEAM, inner:true, layer:L});
        }
      }
    }
  }
}
window.__plateCounts.inner = records.length-OUTER_N; window.__plateCounts.total = records.length;

// ---------- plate geometry: a box with chamfered top edges, so every tile has its own edge catch ----------
function chamferedPlate(cx, cy, cz){
  const X=0.5, Y=0.5, zt=0.5, zb=-0.5, zc=0.5-cz, xi=0.5-cx, yi=0.5-cy;
  const P=[]; const quad=(a,b,c,d)=>P.push(...a,...b,...c, ...a,...c,...d);
  quad([-xi,-yi,zt],[xi,-yi,zt],[xi,yi,zt],[-xi,yi,zt]);                 // top
  quad([-X,-Y,zc],[X,-Y,zc],[xi,-yi,zt],[-xi,-yi,zt]);                   // chamfers
  quad([X,-Y,zc],[X,Y,zc],[xi,yi,zt],[xi,-yi,zt]);
  quad([X,Y,zc],[-X,Y,zc],[-xi,yi,zt],[xi,yi,zt]);
  quad([-X,Y,zc],[-X,-Y,zc],[-xi,-yi,zt],[-xi,yi,zt]);
  quad([-X,-Y,zb],[X,-Y,zb],[X,-Y,zc],[-X,-Y,zc]);                       // walls
  quad([X,-Y,zb],[X,Y,zb],[X,Y,zc],[X,-Y,zc]);
  quad([X,Y,zb],[-X,Y,zb],[-X,Y,zc],[X,Y,zc]);
  quad([-X,Y,zb],[-X,-Y,zb],[-X,-Y,zc],[-X,Y,zc]);
  quad([-X,Y,zb],[X,Y,zb],[X,-Y,zb],[-X,-Y,zb]);                         // bottom
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P,3));
  g.computeVertexNormals();
  return g;
}
const CH = 0.0042; // chamfer width, world units
const geo = chamferedPlate(CH/PITCH_X, CH/PITCH_Y, 0.12);

const N = records.length;
const mat = new THREE.MeshPhysicalMaterial({
  color:0xffffff, metalness:1, roughness:0.24, envMapIntensity:1.0,
  clearcoat:0.42, clearcoatRoughness:0.08
});
// per-plate roughness offset so neighbouring tiles catch the same softbox differently
const leakUniform = {value:0};
mat.onBeforeCompile = (sh)=>{
  sh.uniforms.uLeak = leakUniform;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aRough;\nattribute float aInner;\nvarying float vRough;\nvarying float vInner;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough;\nvInner = aInner;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vRough;\nvarying float vInner;\nuniform float uLeak;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vInner * uLeak * vec3(0.247,0.427,1.0);')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + vRough, 0.05, 1.0);');
};
const mesh = new THREE.InstancedMesh(geo, mat, N);
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
mesh.frustumCulled = false;
group.add(mesh);

// ---------- per-plate typed arrays ----------
const homePos = new Float32Array(N*3), homeQuat = new Float32Array(N*4), normals = new Float32Array(N*3);
const scales = new Float32Array(N*3), randoms = new Float32Array(N*3);
const scatPos = new Float32Array(N*3), tAxis = new Float32Array(N*3), tBase = new Float32Array(N), tSpeed = new Float32Array(N);
const stagger = new Float32Array(N);   // 0..1 along the logo's own diagonal: the order tiles leave and return in
const prog = new Float32Array(N);      // 0 = home, 1 = out in the cloud
const lift = new Float32Array(N);      // damped push/wave lift along the normal
const aRough = new Float32Array(N), aInner = new Float32Array(N);
const flyDelay = new Float32Array(N), retDelay = new Float32Array(N), liftMul = new Float32Array(N), waveF = new Float32Array(N);

// deep anodized navy. Metal takes its colour from reflections, so the base has to sit well above the
// page colour or it reads black; per-plate variation is kept to a few percent of lightness.
const baseCol = new THREE.Color('#122c80'), tmpCol = new THREE.Color();
const _e = new THREE.Euler(), _tq = new THREE.Quaternion(), _hq = new THREE.Quaternion();
const MICRO_TILT = THREE.MathUtils.degToRad(0.38), PILLOW = THREE.MathUtils.degToRad(7);
for(let i=0;i<N;i++){
  const r = records[i];
  // micro-tilt: under 0.4 degrees, enough for a highlight to break across tiles
  // plus a gentle "pillow": normals lean a few degrees toward the edges, so a flat face reflects a
  // sweep of the studio instead of one flat colour and a long soft highlight travels as it turns
  const lx = r.quat.w<0.5 && r.normal.z<0 ? -r.pos.x : r.pos.x;
  const isFace = Math.abs(r.normal.z)>0.5 && !r.inner;
  const pilY = isFace ? (lx/LOGO_W)*2*PILLOW : 0, pilX = isFace ? (-r.pos.y/LOGO_H)*2*PILLOW : (r.inner ? 0 : (r.pos.z/DEPTH)*2*PILLOW*0.6);
  _e.set(pilX+(Math.random()-0.5)*2*MICRO_TILT, pilY+(Math.random()-0.5)*2*MICRO_TILT, 0);
  _hq.copy(r.quat).multiply(_tq.setFromEuler(_e));
  homePos.set([r.pos.x,r.pos.y,r.pos.z], i*3);
  homeQuat.set([_hq.x,_hq.y,_hq.z,_hq.w], i*4);
  normals.set([r.normal.x,r.normal.y,r.normal.z], i*3);
  scales.set([r.sx,r.sy,r.sz], i*3);
  const rx=Math.random()-0.5, ry=Math.random()-0.5, rz=Math.random()-0.5;
  randoms.set([rx,ry,rz], i*3);
  const dist = 0.55 + Math.abs(rx)*1.5;
  // the cloud keeps the mark's silhouette: tiles drift out along their own normal plus a modest jitter
  scatPos.set([r.pos.x*1.1 + r.normal.x*dist + rx*0.9, r.pos.y*1.0 + r.normal.y*dist*0.7 + ry*0.6, r.pos.z + r.normal.z*dist*1.3 + rz*1.6], i*3);
  if(r.inner){ // interior chunks spread wide through the cloud instead of clumping where the body was
    scatPos[i*3] = r.pos.x*1.25 + rx*2.4; scatPos[i*3+1] = r.pos.y*1.12 + ry*1.9; scatPos[i*3+2] = r.pos.z*1.6 + rz*3.4;
  }
  const al = Math.hypot(rx,ry,rz)||1;
  tAxis.set([rx/al, ry/al, rz/al], i*3);
  tBase[i] = 1.2 + Math.random()*3.2;
  tSpeed[i] = (0.25 + Math.random()*0.55) * (Math.random()<0.5?-1:1);
  stagger[i] = THREE.MathUtils.clamp(((r.pos.x/LOGO_W) - (r.pos.y/LOGO_H) + 1)/2 + (Math.random()-0.5)*0.08, 0, 1);
  aRough[i] = (Math.random()-0.5)*0.07 + (r.inner ? 0.14 : 0);
  // inner fragments: same metal, a shade darker; they leave a beat after the skin and come home a beat before it
  const inn = !!r.inner;
  aInner[i] = inn ? 1 : 0;
  flyDelay[i] = inn ? 0.42 + (r.layer===1 ? 0.22 : 0) + Math.random()*0.15 : 0;
  retDelay[i] = inn ? 0 : 0.32;
  liftMul[i] = inn ? (r.layer===1 ? 0.3 : 0.55) : 1;
  // the wave is a 3D field: along the logo's diagonal AND through the depth, so it wraps over the side walls and the neck
  waveF[i] = ((r.pos.x/LOGO_W) - (r.pos.y/LOGO_H) + 1)/2 - (r.pos.z/DEPTH)*0.16;
  const l = (1 + (Math.random()-0.5)*0.06) * (inn ? 0.72 : 1);
  tmpCol.copy(baseCol).multiplyScalar(l);
  mesh.setColorAt(i, tmpCol);
}
geo.setAttribute('aRough', new THREE.InstancedBufferAttribute(aRough,1));
geo.setAttribute('aInner', new THREE.InstancedBufferAttribute(aInner,1));
mesh.instanceColor.needsUpdate = true;

// ---------- layout: fit the object into a region of the container ----------
// options.region() -> {top,bottom} in px (container space). Default: the whole container.
const EXT_H = LOGO_H*Math.cos(BASE_TILT_X) + DEPTH*Math.sin(BASE_TILT_X) + 0.1;
const EXT_W = LOGO_W*0.86 + DEPTH*0.62; // widest silhouette over the idle sway
let fitScale = 1, baseY = 0;
function layout(){
  const W=getW(), H=getH();
  camera.aspect = W/H; camera.updateProjectionMatrix();
  renderer.setSize(W,H);
  const visH = 2*CAM_D*Math.tan(THREE.MathUtils.degToRad(FOV/2)), visW = visH*W/H;
  const reg = (options.region && options.region()) || {top:0, bottom:H};
  const rh = Math.max(80, reg.bottom-reg.top), yc = (reg.top+reg.bottom)/2;
  fitScale = Math.min((options.fillH ?? 0.84)*(rh/H)*visH/EXT_H, (options.fillW ?? 0.8)*visW/EXT_W);
  group.scale.setScalar(fitScale);
  baseY = (0.5-yc/H)*visH;
  group.position.set(0, baseY, 0);
  glow.position.set(0, group.position.y, -2.5); glow.scale.set(11*fitScale, 9*fitScale, 1);
  floorGlow.position.set(0, group.position.y-(EXT_H/2+0.42)*fitScale, -0.5); floorGlow.scale.set(5.4*fitScale, 0.5*fitScale, 1);
}
layout();
let ro = null;
if('ResizeObserver' in window){ ro = new ResizeObserver(layout); ro.observe(container); }
window.addEventListener('resize', layout);

const yawParam = qs.get('yaw');

const debugParam = qs.get('debug');
const dbgEl = document.getElementById('dbg');
if(debugParam && dbgEl) dbgEl.style.display='block';

// ---------- interaction state ----------
const motionParam = parseFloat(qs.get('motion'));
const MOTION = !isNaN(motionParam) ? motionParam : (options.motion ?? 1.5);   // 1.0 = v4 amplitude
const MK = MOTION/1.5;                                                       // v5 numbers below are tuned at 1.5
const RESUME_MS = (options.resumeDelay ?? 1.1)*1000;                          // autopilot resumes this long after the last input
const POINTER_TILT = THREE.MathUtils.degToRad(options.pointerTilt ?? 10);     // lean toward the pointer; 0 disables
let paused = false, expanded = false, userExpanded = false, dragging = false;
let lastX=0, lastY=0, lastMoveT=0, yawVel=0, pitchVel=0;   // velocities in rad/s
let baseYaw = yawParam ? parseFloat(yawParam) : 0.12, basePitch = BASE_TILT_X;              // where the object "is"; pointer tilt rides on top
let tiltYaw = 0, tiltPitch = 0, tiltTX = 0, tiltTY = 0, pointerOver = false;
let resumeEase = 1;                                        // 0 right after the user lets go -> 1, so autopilot never snaps
let lastInteract = -99999;
let swayT = 0;
const PITCH_MAX = THREE.MathUtils.degToRad(70);

// ---------- autopilot: about half rest, half beats; the first beat follows the assemble directly ----------
const beatOverride = options.beat || qs.get('beat'); // none|wave|ghost|ghostside|burst|expand, for testing
const PROGRAM = options.program || [['wave',2600],['rest',3200],['ghost',4600],['rest',3400],['expand',5600],['rest',4200],['burst',1800],['rest',3000],['ghost',4600],['rest',2800]];
let progIdx = -1, ghostCount = 0, ghostSide = false, ghostStart = 0;
let autoMode = 'intro', autoModeStart = performance.now(), autoDur = 2700;
let inView = true, burstCenter = null;

const raycaster = new THREE.Raycaster();
let scatterPoint = null, scatterActive = 0, scatterStrength = 1;

const _inv = new THREE.Matrix4(), _lray = new THREE.Ray();
// pointer -> the true 3D point where the ray meets the FORM (local space). v4 intersected only the z-plane of the
// camera-facing face, so at a grazing angle the point landed far off the object and the side walls never reacted.
// Now: march the ray through the extruded outline (inside(u,v) x depth). Front, back, side walls and the neck all hit.
const HZ = DEPTH/2 + SZ;
function insideLocal(x,y,z){ return Math.abs(z)<=HZ && inside(x/LOGO_W+0.5, 0.5-y/LOGO_H); }
function pointerToLocal(clientX, clientY){
  const rect = container.getBoundingClientRect();
  const nx = ((clientX-rect.left)/rect.width)*2-1, ny = -((clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera({x:nx,y:ny}, camera);
  group.updateMatrixWorld();
  _lray.copy(raycaster.ray).applyMatrix4(_inv.copy(group.matrixWorld).invert());
  _lray.direction.normalize();
  const o=_lray.origin, d=_lray.direction;
  // closest approach to the centre bounds the march
  const tc = -(o.x*d.x+o.y*d.y+o.z*d.z), R = Math.hypot(LOGO_W,LOGO_H,DEPTH)*0.5+0.2;
  const STEP = 0.03;
  for(let t=Math.max(0,tc-R); t<tc+R; t+=STEP){
    const x=o.x+d.x*t, y=o.y+d.y*t, z=o.z+d.z*t;
    if(insideLocal(x,y,z)){
      // refine back to the surface
      let t0=t-STEP, t1=t;
      for(let k=0;k<5;k++){ const tm=(t0+t1)/2; if(insideLocal(o.x+d.x*tm,o.y+d.y*tm,o.z+d.z*tm)) t1=tm; else t0=tm; }
      return {point:new THREE.Vector3(o.x+d.x*t1,o.y+d.y*t1,o.z+d.z*t1), strength:1};
    }
  }
  // missed the form: fall back to the nearest tile to the ray, fading with distance
  let best=-1, bd=1e9;
  for(let i=0;i<OUTER_N;i+=5){
    const i3=i*3, vx=homePos[i3]-o.x, vy=homePos[i3+1]-o.y, vz=homePos[i3+2]-o.z;
    const tt=vx*d.x+vy*d.y+vz*d.z;
    const ex=vx-d.x*tt, ey=vy-d.y*tt, ez=vz-d.z*tt, dd=ex*ex+ey*ey+ez*ez;
    if(dd<bd){ bd=dd; best=i; }
  }
  const NEAR = 1.1, dist=Math.sqrt(bd);
  if(best<0 || dist>NEAR) return null;
  const f = 1-dist/NEAR;
  return {point:new THREE.Vector3(homePos[best*3],homePos[best*3+1],homePos[best*3+2]), strength:f*f*(3-2*f)};
}
function userTouched(now){
  lastInteract = now;
  if(autoMode==='expand' && !userExpanded) expanded = false; // the autopilot yields
}

let downTime=0, downPos=[0,0];
function onPointerDown(e){
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  downTime = lastMoveT = performance.now(); downPos = [e.clientX, e.clientY];
  yawVel = pitchVel = 0;
  try{ renderer.domElement.setPointerCapture(e.pointerId); }catch(_){}
  userTouched(downTime);
}
function onPointerMove(e){
  const now = performance.now();
  const rect = container.getBoundingClientRect();
  pointerOver = e.pointerType!=='touch' && (options.gazeAnywhere || (e.clientX>=rect.left && e.clientX<=rect.right && e.clientY>=rect.top && e.clientY<=rect.bottom));
  tiltTX = THREE.MathUtils.clamp(((e.clientX-rect.left)/rect.width)*2-1, -1, 1);
  tiltTY = THREE.MathUtils.clamp(((e.clientY-rect.top)/rect.height)*2-1, -1, 1);
  if(dragging){
    const dx = e.clientX-lastX, dy = e.clientY-lastY;
    const dts = Math.max(0.004, (now-lastMoveT)/1000);
    lastX = e.clientX; lastY = e.clientY; lastMoveT = now;
    // 1:1 feel: dragging across the object's own width turns it about half a turn
    const k = Math.PI / Math.max(220, objectPx());
    baseYaw += dx*k;                                           // free, full 360
    basePitch = THREE.MathUtils.clamp(basePitch + dy*k, -PITCH_MAX, PITCH_MAX);
    yawVel = yawVel*0.5 + (dx*k/dts)*0.5; pitchVel = pitchVel*0.5 + (dy*k/dts)*0.5;
    userTouched(now);
  }
  const hit = pointerToLocal(e.clientX, e.clientY);
  if(hit){ scatterPoint = hit.point; scatterStrength = hit.strength; scatterActive = 1; if(hit.strength>0.6) userTouched(now); }
}
function objectPx(){
  const visH = 2*CAM_D*Math.tan(THREE.MathUtils.degToRad(FOV/2));
  return LOGO_W*fitScale/visH*getH();
}
function onPointerUp(e){
  if(!dragging) return;
  const now = performance.now();
  const dt = now - downTime;
  const dx = Math.abs(e.clientX-downPos[0]), dy = Math.abs(e.clientY-downPos[1]);
  dragging = false;
  if(now-lastMoveT > 90){ yawVel = pitchVel = 0; }             // he stopped before letting go: it stays put
  yawVel = THREE.MathUtils.clamp(yawVel, -14, 14); pitchVel = THREE.MathUtils.clamp(pitchVel, -8, 8);
  lastInteract = now;
  if(options.tapExpand!==false && e.type!=='pointercancel' && dt < 300 && dx < 6 && dy < 6) toggleExpand();
}
function onPointerLeave(){ scatterActive = Math.min(scatterActive, 0.5); }
function onDocLeave(){ pointerOver = false; }
renderer.domElement.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
renderer.domElement.addEventListener('pointerleave', onPointerLeave);
document.documentElement.addEventListener('pointerleave', onDocLeave);

function toggleExpand(){ expanded = !expanded; userExpanded = expanded; lastInteract = performance.now(); }

const io = new IntersectionObserver((entries)=>{ for(const e of entries) inView = e.isIntersecting; }, {threshold:0.05});
io.observe(container);
const clock = new THREE.Clock();
let visible = !document.hidden;
function onVisibilityChange(){ visible = !document.hidden; }
document.addEventListener('visibilitychange', onVisibilityChange);

let fpsFrames=0, fpsTime=0;
window.__fps = 0;

function enterMode(mode, dur, now){
  autoMode = mode; autoModeStart = now; autoDur = dur;
  if(mode==='burst'){
    let idx = Math.floor(Math.random()*OUTER_N);              // any surface: front face or a side wall
    if(normals[idx*3+2] < -0.5) idx -= 1;                     // back-face plate -> its front partner (autopilot faces front)
    burstCenter = [homePos[idx*3], homePos[idx*3+1], homePos[idx*3+2]];
  }
  if(mode==='ghost' || mode==='ghostside'){
    ghostSide = mode==='ghostside' || (ghostCount++ % 2 === 1);   // every other ghost glides along a side wall and round the neck
    ghostStart = Math.floor(Math.random()*OUTLINE.length);
    if(mode==='ghostside'){ ghostStart = NECK_IDX; }
  }
  if(!userExpanded) expanded = (mode==='expand');
}
function nextBeat(now){
  if(beatOverride){ enterMode(beatOverride, 1e12, now); return; }
  progIdx = (progIdx+1) % PROGRAM.length;
  enterMode(PROGRAM[progIdx][0], PROGRAM[progIdx][1], now);
}

// intro: start out in the cloud and land in order, unless reduced motion or a test beat wants a stable frame
const skipIntro = reducedMotion || !!beatOverride || options.intro===false;
let seam = 0, leak = 0;
if(!skipIntro){ prog.fill(1); seam = 1; }
else if(beatOverride) nextBeat(performance.now());

const smoother = (t)=> t*t*t*(t*(t*6-15)+10);
const PUSH_R = 1.2, PUSH_F = 0.63, RIP_R = 2.5;   // v4: 0.8 / 0.42, no ripple
const OPEN_S = 0.6, FLY_S = 1.25, FLY_STAGGER = 0.75, RET_S = 1.15, RET_STAGGER = 0.9;
let flyClock = 0; // seconds since the current fly-out / return started
let lastDir = expanded;

function updatePlates(dt, now, timeS){
  const el = (now-autoModeStart)/1000;
  const waving = autoMode==='wave', ghosting = autoMode==='ghost'||autoMode==='ghostside', bursting = autoMode==='burst' && burstCenter;
  const WAVE_H = 0.3*MK, WAVE_PERIOD = 1.55;
  const waveFront = waving ? THREE.MathUtils.lerp(-0.3, 1.3, ((el*Math.max(0.6,MK))%(WAVE_PERIOD+0.35))/WAVE_PERIOD) : 0;
  let ghostX=0, ghostY=0, ghostZ=DEPTH/2;
  if(ghosting){
    if(ghostSide){
      const f = ghostStart + el*OUTLINE.length*0.11*Math.max(0.6,MK);
      const a = OUTLINE[Math.floor(f)%OUTLINE.length], b = OUTLINE[(Math.floor(f)+1)%OUTLINE.length], ft = f-Math.floor(f);
      ghostX = a[0]+(b[0]-a[0])*ft; ghostY = a[1]+(b[1]-a[1])*ft; ghostZ = Math.sin(el*1.9)*DEPTH*0.32;
    } else {
      const cov = Math.min(0.46, 0.42*MK);
      ghostX = Math.sin(el*1.65)*LOGO_W*cov; ghostY = Math.sin(el*2.55+1.1)*LOGO_H*cov;
    }
  }
  const burstEnv = bursting ? Math.sin(THREE.MathUtils.clamp((el%2.4)/1.5,0,1)*Math.PI) : 0;
  const GH_R = LOGO_W*0.3, GH_H = 0.46*MK, BU_R = LOGO_W*0.45*Math.min(1.2,MK), BU_H = 0.95*MK;

  // seam: opens before anything flies, closes only after everything is home
  if(expanded !== lastDir){ lastDir = expanded; flyClock = 0; }
  let maxProg = 0;
  for(let i=0;i<N;i+=37) if(prog[i]>maxProg) maxProg = prog[i];
  const seamTarget = (expanded || maxProg>0.004) ? 1 : 0;
  seam = THREE.MathUtils.clamp(seam + (seamTarget>seam?1:-1)*dt/OPEN_S, 0, 1);
  const seamE = smoother(seam);
  const canFly = expanded && seam>=0.999;
  if(canFly || !expanded) flyClock += dt;

  const arr = mesh.instanceMatrix.array;
  let busy = waving||ghosting||bursting||scatterActive>0.01||seam>0;
  const dampK = 1-Math.exp(-8*dt);
  const sp = scatterPoint;
  for(let i=0;i<N;i++){
    const i3=i*3, i4=i*4;
    const hx=homePos[i3], hy=homePos[i3+1], hz=homePos[i3+2];
    const nx=normals[i3], ny=normals[i3+1], nz=normals[i3+2];
    const st = stagger[i];

    // --- fly progress, in order along the diagonal ---
    let p = prog[i];
    if(canFly){ if(flyClock > st*FLY_STAGGER + flyDelay[i] && p<1) p = Math.min(1, p + dt/FLY_S); }
    else if(!expanded && p>0){ if(flyClock > st*RET_STAGGER + retDelay[i]) p = Math.max(0, p - dt/RET_S); }
    prog[i] = p;
    const pe = p<=0 ? 0 : p>=1 ? 1 : smoother(p);

    // --- lift target (push / wave / ghost / burst) ---
    let lt = 0;
    if(waving){ const d = waveF[i]-waveFront; lt = WAVE_H*Math.exp(-(d*d)/0.014); }
    else if(ghosting){ const d = Math.hypot(hx-ghostX, hy-ghostY, hz-ghostZ); if(d<GH_R){ const f=1-d/GH_R; lt = f*f*GH_H; } }
    else if(bursting){ const d = Math.hypot(hx-burstCenter[0], hy-burstCenter[1], hz-burstCenter[2]); if(d<BU_R){ const f=1-d/BU_R; lt = f*f*burstEnv*BU_H; } }
    if(sp && scatterActive>0.01){
      // true 3D distance from the hit point: a side-wall hit lifts side tiles, an edge hit lifts face + side together
      const d = Math.hypot(hx-sp.x, hy-sp.y, hz-sp.z), sa = scatterActive*scatterStrength;
      if(d<PUSH_R){ const f=1-d/PUSH_R; lt += f*f*(3-2*f)*sa*PUSH_F; }
      if(d<RIP_R){ const g=1-d/RIP_R; lt += g*g*sa*0.085*(0.5+0.5*Math.sin(d*7.5 - timeS*9)); }   // neighbours ripple outward
    }
    lt *= liftMul[i];
    let l = lift[i]; l += (lt-l)*dampK; if(l<0.0004 && lt===0) l=0; lift[i]=l;
    if(l>0) busy = true;

    // --- position ---
    const seamLift = seamE*0.035*(1-pe) + l;
    const rx=randoms[i3], ry=randoms[i3+1], rz=randoms[i3+2];
    let px = hx + nx*seamLift + rx*l*0.25, py = hy + ny*seamLift + ry*l*0.25, pz = hz + nz*seamLift + rz*l*0.25;
    let qx=homeQuat[i4], qy=homeQuat[i4+1], qz=homeQuat[i4+2], qw=homeQuat[i4+3];
    const ang = pe*(tBase[i] + timeS*tSpeed[i]) + l*rx*1.6;
    if(pe>0){
      const drift = pe*0.12;
      px += (scatPos[i3]   + Math.sin(timeS*0.5+rx*9)*drift - px)*pe;
      py += (scatPos[i3+1] + Math.cos(timeS*0.43+ry*9)*drift - py)*pe;
      pz += (scatPos[i3+2] - pz)*pe;
    }
    if(ang!==0){
      const h=ang*0.5, s=Math.sin(h), ax=tAxis[i3]*s, ay=tAxis[i3+1]*s, az=tAxis[i3+2]*s, aw=Math.cos(h);
      const bx=qx, by=qy, bz=qz, bw=qw;
      qx = bw*ax + bx*aw + by*az - bz*ay;
      qy = bw*ay - bx*az + by*aw + bz*ax;
      qz = bw*az + bx*ay - by*ax + bz*aw;
      qw = bw*aw - bx*ax - by*ay - bz*az;
    }
    // --- seams crack open: plates shrink a touch so the core light leaks between them ---
    const shrink = 1 - 0.17*seamE*(1-pe);
    const fs = aInner[i] ? 1-0.42*pe : 1;   // interior chunks slim down in flight so the cloud reads as fragments, not slabs
    const sx=scales[i3]*shrink*fs, sy=scales[i3+1]*shrink*fs, sz=scales[i3+2]*fs;
    const x2=qx+qx, y2=qy+qy, z2=qz+qz;
    const xx=qx*x2, xy=qx*y2, xz=qx*z2, yy=qy*y2, yz=qy*z2, zz=qz*z2, wx=qw*x2, wy=qw*y2, wz=qw*z2;
    const o=i*16;
    arr[o]=(1-(yy+zz))*sx; arr[o+1]=(xy+wz)*sx; arr[o+2]=(xz-wy)*sx; arr[o+3]=0;
    arr[o+4]=(xy-wz)*sy; arr[o+5]=(1-(xx+zz))*sy; arr[o+6]=(yz+wx)*sy; arr[o+7]=0;
    arr[o+8]=(xz+wy)*sz; arr[o+9]=(yz-wx)*sz; arr[o+10]=(1-(xx+yy))*sz; arr[o+11]=0;
    arr[o+12]=px; arr[o+13]=py; arr[o+14]=pz; arr[o+15]=1;
  }
  mesh.instanceMatrix.needsUpdate = true;

  // --- light leak without a body: the INNER FRAGMENTS glow cool blue through the seams as they open,
  // and drop to a smoulder once everything is flying. Nothing solid exists at any point. ---
  let sumP = 0, cnt = 0; for(let i=0;i<N;i+=23){ sumP += prog[i]; cnt++; }
  const away = sumP/cnt;
  const leakTarget = seamE*((canFly || maxProg>0.004) ? 0.04 : 1);
  leak += (leakTarget-leak)*(1-Math.exp(-10*dt));
  leakUniform.value = leak*1.6;
  glowMat.opacity = 0.2 + leak*0.5;
  floorMat.opacity = 0.34*(1-away*0.6) + leak*0.3;
  return busy || expanded;
}
updatePlates(0, performance.now(), 0);

let disposed = false, rafId = null, timeS = 0, idleFrames = 0;
function frame(){
  if(disposed) return;
  rafId = requestAnimationFrame(frame);
  if(!(visible && inView)){ clock.getDelta(); return; }
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  timeS += dt;

  fpsFrames++; fpsTime += dt;
  if(fpsTime>0.5){ window.__fps = Math.round(fpsFrames/fpsTime); fpsFrames=0; fpsTime=0;
    if(debugParam && dbgEl) dbgEl.textContent = `fps ${window.__fps} | plates ${N} | mode ${autoMode} | seam ${seam.toFixed(2)}`;
  }

  const spinning = Math.abs(yawVel)>0.25 || Math.abs(pitchVel)>0.25;
  if(!dragging && spinning) lastInteract = now;               // a flick counts as his until it settles
  const userInteracting = dragging || (now-lastInteract) < RESUME_MS;
  const autopilotOn = !paused && !userInteracting;

  // ---- orientation = base (autopilot sway OR where he put it) + pointer lean + float ----
  if(!paused){
    if(dragging){ resumeEase = 0; }
    else if(userInteracting){
      resumeEase = 0;
      const dec = Math.exp(-2.4*dt);                           // inertia: flick to spin
      baseYaw += yawVel*dt; basePitch = THREE.MathUtils.clamp(basePitch + pitchVel*dt, -PITCH_MAX, PITCH_MAX);
      yawVel *= dec; pitchVel *= dec;
    } else if(!yawParam){
      yawVel = pitchVel = 0;
      resumeEase = Math.min(1, resumeEase + dt/1.6);           // ease back from wherever he left it, no snap
      swayT += dt;
      // sway about the readable front three-quarter. Never past ~60 degrees, so autopilot never shows the mark mirrored.
      const targetYaw = THREE.MathUtils.clamp(0.12 + 0.09*MOTION + Math.sin(swayT*0.3+0.9)*0.5*MOTION + Math.sin(swayT*0.71)*0.06*MOTION, -0.55, 1.08)  /* left limit: past -0.55 the face loses the key softbox and goes dark */;
      const targetPitch = BASE_TILT_X + Math.sin(swayT*0.21+1)*0.05*MOTION;
      baseYaw = Math.atan2(Math.sin(baseYaw), Math.cos(baseYaw)); // unwind after a big spin
      const k = (1-Math.exp(-1.7*dt))*smoother(resumeEase);
      baseYaw += (targetYaw-baseYaw)*k;
      basePitch += (targetPitch-basePitch)*k;
    }
    const wantTilt = pointerOver && !dragging && POINTER_TILT>0;
    const kt = 1-Math.exp(-(wantTilt?5:2.5)*dt);
    tiltYaw += ((wantTilt ? tiltTX*POINTER_TILT : 0)-tiltYaw)*kt;
    tiltPitch += ((wantTilt ? tiltTY*POINTER_TILT*0.8 : 0)-tiltPitch)*kt;
    const fl = yawParam ? 0 : 1;
    group.rotation.y = baseYaw + tiltYaw;
    group.rotation.x = basePitch + tiltPitch;
    group.rotation.z = fl*Math.sin(timeS*0.43+2)*0.014*MOTION;
    group.position.y = baseY + fl*Math.sin(timeS*0.62)*0.055*MOTION*fitScale;   // gentle float
    group.position.x = fl*Math.sin(timeS*0.37+1)*0.03*MOTION*fitScale;
  }

  // ---- autopilot program ----
  if(autopilotOn){
    if(userExpanded && (now-lastInteract) > 6500){ userExpanded = false; expanded = false; enterMode('rest', 2600, now); }
    else if(!userExpanded && now-autoModeStart > autoDur) nextBeat(now);
  } else if(userInteracting && autoMode!=='rest' && autoMode!=='intro' && !beatOverride){
    enterMode('rest', 700, now);   // beats pick up again soon after he lets go
  }
  scatterActive *= Math.exp(-1.5*dt);

  // skip the per-plate loop entirely once everything has been home and still for a few frames
  const mightMove = expanded || seam>0 || scatterActive>0.01 || autoMode==='wave' || autoMode==='ghost' || autoMode==='ghostside' || autoMode==='burst';
  if(mightMove || idleFrames<=4){
    const busy = updatePlates(dt, now, timeS);
    idleFrames = (busy || mightMove) ? 0 : idleFrames+1;
  }
  renderer.render(scene, camera);
}

function initReveal(){
  renderer.domElement.style.opacity = '1';
  if(options.onReveal) options.onReveal();
}
if(reducedMotion){
  // poster-only: the canvas never fades in and the render loop never starts
} else if('requestIdleCallback' in window) requestIdleCallback(initReveal, {timeout:800});
else setTimeout(initReveal, 300);

if(!reducedMotion) frame();
else renderer.render(scene, camera);

// ---------- public control API ----------
function pause(){ paused = true; }
function resume(){ paused = false; lastInteract = performance.now(); }
function expand(){ expanded = true; userExpanded = true; lastInteract = performance.now(); }
function reset(){ expanded = false; userExpanded = false; lastInteract = performance.now(); }
function dispose(){
  disposed = true;
  if(rafId) cancelAnimationFrame(rafId);
  if(ro) ro.disconnect();
  window.removeEventListener('resize', layout);
  io.disconnect();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  renderer.domElement.removeEventListener('pointerdown', onPointerDown);
  renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  document.documentElement.removeEventListener('pointerleave', onDocLeave);
  geo.dispose(); mat.dispose();
  glowTex.dispose(); glowMat.dispose(); floorMat.dispose();
  envDisposables.forEach(d=>d.dispose());
  envRT.dispose(); pmrem.dispose();
  renderer.dispose();
  if(renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
}

return {pause, resume, expand, reset, dispose, relayout:layout, state:()=>({mode:autoMode, expanded, seam, plates:N, yaw:group.rotation.y, pitch:group.rotation.x, motion:MOTION})};
}

// ---------- one-pager mount (Wing Digital pitch page) ----------
// v5 sculpture code above is ported from creative-tools/wing-logo-3d/sculpture.html (2026-09-18); the only
// additions are opt-in switches (program, intro, gazeAnywhere, tapExpand). Here it starts small in the hero,
// then on wide screens glides to a small dock in the bottom-left corner and stays with you down the page.
const stage = document.getElementById('pieceStage');
const hit = document.getElementById('pieceHit');
if(stage){
  const ok = (()=>{ try{ const c=document.createElement('canvas'); return !!(c.getContext('webgl2')||c.getContext('webgl')); }catch(e){ return false; } })();
  if(ok){
    const piece = initWingSculpture(stage, {
      fillH: 0.31, fillW: 0.31, backdropGlow: false,   // big transparent stage, small logo: the motion never hits an edge
      motion: 1.0, intro: false, gazeAnywhere: true, tapExpand: false,
      program: [['rest',4500],['wave',2600],['rest',6500],['ghost',4600]],
      onReveal(){ stage.classList.add('live'); }
    });
    window.__wingSculpture = piece;
    // drag to spin: the stage ignores clicks so the page under it stays usable; a small grab spot over the logo forwards them
    if(hit){
      const cv = stage.querySelector('canvas');
      hit.addEventListener('pointerdown', (e)=>{ e.preventDefault(); cv.dispatchEvent(new PointerEvent('pointerdown', e)); hit.classList.add('grab'); });
      window.addEventListener('pointerup', ()=> hit.classList.remove('grab'));
    }
    // follow the page: hero spot -> bottom-left dock, eased by scroll (wide screens only)
    const heroIn = document.querySelector('.hero-in');
    const wide = window.matchMedia('(min-width: 1180px)');
    const DOCK = 0.372, W = 700, H = 720;
    let raf = 0;
    const ease = (t)=> t*t*(3-2*t);
    function place(){
      raf = 0;
      if(!wide.matches){ stage.classList.remove('follow'); stage.style.transform=''; return; }
      stage.classList.add('follow');
      const r = heroIn.getBoundingClientRect();
      const hx = r.right - 170, hy = r.top + 260;            // hero spot, moves up with the hero
      const dx = 72, dy = innerHeight - 80;                  // dock, bottom-left
      const t = ease(Math.min(1, Math.max(0, scrollY/520)));
      const s = 1 + (DOCK-1)*t;
      const cx = hx + (dx-hx)*t, cy = hy + (dy-hy)*t;
      stage.style.transform = `translate(${cx - W/2}px, ${cy - H/2}px) scale(${s})`;
    }
    const req = ()=>{ if(!raf) raf = requestAnimationFrame(place); };
    addEventListener('scroll', req, {passive:true}); addEventListener('resize', req);
    if(wide.addEventListener) wide.addEventListener('change', req);
    place();
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>{ piece.relayout(); place(); });
  }
}
