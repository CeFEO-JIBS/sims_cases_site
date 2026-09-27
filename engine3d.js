// engine3d.js — the 3D layer for sims_cases.
//
// The engine in index.html keeps simulating everything: who is where, who speaks, the script,
// decisions, meters, the narrator. This module only paints it. Each frame it reads the engine's
// people and camera, poses a KayKit-rigged Nordic Cast persona for each, and draws the room with
// three.js on a canvas *under* the engine's own canvas — which keeps drawing names, bubbles,
// thoughts and emotes on top, at the head positions this module hands back.
//
// Space: one engine tile is one unit. x is the engine's x, z is the engine's y, y is up.
// The engine's P() projection is reproduced exactly by an orthographic camera at 45° azimuth and
// 30° elevation (one tile = 128 x 64 px), so both canvases line up to the pixel.

import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------- scale
// The cast and KayKit's furniture are authored together: Sit_Chair_Idle was built on KayKit's
// chair_A. Both keep that relationship and are scaled as a pair so a persona (2.217 tall as
// authored) stands 1.73 tiles, the height of the engine's 2D figures.
export const KK = 0.78;
const SIT_FWD = 0.40 * KK;            // Sit_Chair_Idle parks the hips 0.40 behind the root
const SEAT_Y = 0.5 * KK;               // the chair seat the clip was made on (KayKit chair_A)
const CHILD = 0.74;                    // a child part is played by a young adult persona at this size
const HW = 64, K = HW / Math.cos(Math.PI / 4), EL = Math.PI / 6;
const DIR = new THREE.Vector3(Math.cos(EL) * Math.SQRT1_2, Math.sin(EL), Math.cos(EL) * Math.SQRT1_2);
const FACE = {'+x':[1,0], '-x':[-1,0], '+y':[0,1], '-y':[0,-1]};
const MOTION = 0.45;                  // how much of a talking/listening clip survives over the still sit pose

const PRESET = {Neutral:{}, Relaxed:{u:'Relaxed',m:'Relaxed'}, Thinking:{u:'Thinking',m:'Frown'},
  Happy:{u:'Happy',m:'Smile'}, Skeptical:{u:'Skeptical',m:'Skeptical'}, Worried:{u:'Worried',m:'Worried'},
  Angry:{u:'Angry',m:'Angry'}, Sad:{u:'Sad',m:'Sad'}, Surprised:{u:'Surprised',m:'Surprised'}};
const MOOD = {smile:'Happy', neutral:'Neutral', frown:'Angry', smirk:'Skeptical', worry:'Worried', sad:'Sad'};
const EMOTE = {'!':'Surprised', '?':'Skeptical', dots:'Thinking', anger:'Angry', storm:'Angry', spark:'Happy', sweat:'Worried'};

// ---------------------------------------------------------------- loading
// Assets arrive as ArrayBuffers (the page's loader streams them with a progress bar); this only parses.
const loader = new GLTFLoader();
// Embedded textures: force the <img> path. GLTFLoader otherwise fetches a blob: URL through
// ImageBitmapLoader, which a strict connect-src refuses, and every model comes out white.
loader.register(parser => { parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
                            return {name:'force_img_textures'} });
const parse = buf => new Promise((res, rej) => loader.parse(buf, '', res, rej));

export function webglOK(){
  try{ const c=document.createElement('canvas'); return !!(c.getContext('webgl2')||c.getContext('webgl')) }
  catch(e){ return false }
}

// ---------------------------------------------------------------- the layer
export function create(stage){
  const canvas = document.createElement('canvas');
  canvas.className = 'e3d';
  canvas.setAttribute('aria-hidden','true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none';
  stage.insertBefore(canvas, stage.firstChild);

  const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
  // if the browser drops the GPU context (memory pressure on a tablet), say so: the page falls back
  // to the classic room instead of showing an empty stage
  let lost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; ready = false;
    window.dispatchEvent(new CustomEvent('e3d-lost')) });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const ortho = new THREE.OrthographicCamera(-1,1,1,-1,-200,200); ortho.up.set(0,1,0);
  const persp = new THREE.PerspectiveCamera(16.06, 1, 0.05, 200);   // 85 mm on full frame

  const hemi = new THREE.HemisphereLight(0xfff6ea, 0x9aa4ab, 1.05); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0dc, 1.7);
  key.position.set(13, 16, 11); key.castShadow = true;
  key.shadow.mapSize.set(2048,2048); key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; key.shadow.radius = 2.4;
  Object.assign(key.shadow.camera, {left:-9, right:9, top:9, bottom:-9, near:1, far:60});
  key.target.position.set(5, 0, 3.5); scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xd8e6f2, 0.45); fill.position.set(-6, 5, -4); scene.add(fill);

  const room = new THREE.Group(); scene.add(room);
  const cast = new THREE.Group(); scene.add(cast);

  let clips = {};             // name -> AnimationClip, from the shared meeting file
  let actors = {};            // engine person id -> actor
  let ready = false, lastCase = null, layout = 'boardroom';

  // ------------------------------------------------ case assets
  // files: {path: ArrayBuffer}. manifest.models = {people:{cid:path}, clips:[paths], room:{piece:path}}
  const pieces = {};          // room piece name -> gltf scene (template)
  const personas = {};        // cid -> gltf
  const images = {};          // name -> texture
  // Free what the GPU holds for a subtree. Pieces placed in a room share geometry and materials
  // with their template (userData.shared), and window views are cached: those stay until the case changes.
  function dispose(root, all){
    root.traverse(o => {
      if(!all && o.userData.shared) return;
      if(o.geometry) o.geometry.dispose();
      if(all && o.skeleton) o.skeleton.dispose();         // each skinned mesh keeps a bone texture on the GPU
      for(const m of [].concat(o.material || [])){
        for(const k in m){ const t = m[k]; if(t && t.isTexture && (all || !t.userData.keep)) t.dispose() }
        m.dispose() }
    });
  }
  async function loadCase(manifest, files){
    ready = false;
    const m = manifest.models;
    // a new case: free the last case's people, pieces and room before loading this one's
    lastCase = null; room.clear(); cast.clear(); actors = {};
    for(const k in pieces){ dispose(pieces[k], true); delete pieces[k] }
    for(const k in personas){ dispose(personas[k].scene, true) }
    for(const k in images){ images[k].dispose(); delete images[k] }
    clips = {};
    for(const p of m.clips){ const g = await parse(files[p]); g.animations.forEach(a => clips[a.name] = a) }
    for(const [name, p] of Object.entries(m.room)) pieces[name] = (await parse(files[p])).scene;
    for(const k in personas) delete personas[k];
    for(const [cid, p] of Object.entries(m.people)) personas[cid] = await parse(files[p]);
    for(const [name, p] of Object.entries(m.images || {})){      // pictures a room hangs (Nygaard's painting)
      const url = URL.createObjectURL(new Blob([files[p]], {type:'image/jpeg'}));
      const t = await new THREE.TextureLoader().loadAsync(url); URL.revokeObjectURL(url);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.userData.keep = true; images[name] = t }
    layout = m.layout || 'boardroom'; lastCase = manifest.id; ready = true;
  }

  // ------------------------------------------------ the room
  function place(name, x, z, ry=0, y=0, s=KK, opts={}){
    const t = pieces[name]; if(!t) return null;
    const o = t.clone(true); o.traverse(n => { n.userData.shared = true });
    o.position.set(x, y, z); o.rotation.y = ry;
    if(Array.isArray(s)) o.scale.set(...s); else o.scale.setScalar(s);
    o.traverse(n => { if(n.isMesh){ n.castShadow = opts.shadow!==false; n.receiveShadow = true;
      if(n.material && n.material.name==='glass'){ n.material = n.material.clone();
        Object.assign(n.material,{transparent:true, opacity:.3, roughness:.06, depthWrite:false});
        n.material.color = new THREE.Color('#CFE2EC'); n.material.emissive = new THREE.Color('#EAF3F8');
        n.material.emissiveIntensity = .5 } } });
    room.add(o); return o;
  }
  const mat = (c, r=0.9) => new THREE.MeshStandardMaterial({color:new THREE.Color(c), roughness:r});
  function slab(x0,z0,x1,z1,y0,y1,color,r){
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1-x0, y1-y0, z1-z0), mat(color,r));
    m.position.set((x0+x1)/2, (y0+y1)/2, (z0+z1)/2); m.receiveShadow = true; m.castShadow = y1-y0 > .2;
    room.add(m); return m;
  }
  // large stone slabs, one tile each, in slightly varied greys (the classic 'stone' floor)
  function stone(base){
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
    const b = new THREE.Color(base);
    for(let i=0;i<2;i++) for(let j=0;j<2;j++){ const k = [0, .05, -.04, .03][i*2+j], col = b.clone().offsetHSL(0, 0, k);
      g.fillStyle = '#' + col.getHexString(); g.fillRect(i*128, j*128, 128, 128) }
    g.strokeStyle = 'rgba(30,30,30,.25)'; g.lineWidth = 2;
    for(let u=0; u<=256; u+=128){ g.beginPath(); g.moveTo(u,0); g.lineTo(u,256); g.stroke(); g.beginPath(); g.moveTo(0,u); g.lineTo(256,u); g.stroke() }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // half-tile ceramic floor tiles with light grout (the classic 'tile' floor)
  function tiles(base){
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0,0,256,256);
    g.strokeStyle = 'rgba(80,80,80,.14)'; g.lineWidth = 2;
    for(let u=0; u<=256; u+=64){ g.beginPath(); g.moveTo(u,0); g.lineTo(u,256); g.stroke(); g.beginPath(); g.moveTo(0,u); g.lineTo(256,u); g.stroke() }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function planks(base, dark){
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0,0,256,256);
    g.strokeStyle = dark; g.lineWidth = 2; g.globalAlpha = .35;
    for(let i=0;i<8;i++){ g.beginPath(); g.moveTo(0, i*32); g.lineTo(256, i*32); g.stroke();
      const o = (i*97)%256; g.beginPath(); g.moveTo(o, i*32); g.lineTo(o, i*32+32); g.stroke() }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // the dado of the classic room: a rail on top and a moulded panel per tile (2D: z 0..30 of 104)
  const DADO = .77;
  function wainscot(base, line){
    const c = document.createElement('canvas'); c.width = 128; c.height = 98; const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0,0,128,98);
    g.fillStyle = line; g.fillRect(0,0,128,6);
    g.strokeStyle = line; g.lineWidth = 3; g.strokeRect(16,22,96,62);
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // the classic room's potted plant: a square pot and seven leaf balls (index.html, plant())
  const LEAVES = [[0,0,30,11],[.1,-.08,40,9],[-.09,.09,38,9],[.02,.03,49,8],[.13,.1,27,8],[-.12,-.06,28,8],[-.02,-.12,34,8]];
  function plant(x, z, size=1, pot='#E9E6E0'){
    const Z = 1/39.2, R = 1/45;                       // 2D z units and screen radii in tiles
    slab(x-.15, z-.15, x+.15, z+.15, 0, 15*size*Z, pot, .8).castShadow = true;
    LEAVES.forEach(([dx,dz,h,r], i) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r*size*R, 1),
        new THREE.MeshStandardMaterial({color:i%2?'#7E9B77':'#688862', roughness:.9, flatShading:true}));
      m.position.set(x+dx, h*size*Z, z+dz); m.castShadow = true; room.add(m) });
  }
  // the classic room's abstract print: a walnut frame, sage, fjord blue, clay and mustard on cream
  function painting(x0, x1, y0, y1){
    const w = x1-x0, h = y1-y0, S = 8;
    const c = document.createElement('canvas'); c.width = 58*S; c.height = 52*S; const g = c.getContext('2d');
    g.scale(c.width/57.6, c.height/52);
    g.fillStyle = '#6E5540'; g.fillRect(0,0,57.6,52); g.fillStyle = '#EFE8DA'; g.fillRect(3,3,51.6,46);
    g.fillStyle = '#9DB09A'; g.beginPath(); g.arc(18,22,11,0,6.283); g.fill();
    g.fillStyle = '#8DA3B2'; g.fillRect(27,10,17,30);
    g.fillStyle = '#C4927A'; g.beginPath(); g.arc(41,37,7,0,6.283); g.fill();
    g.fillStyle = '#D2A64F'; g.fillRect(8,40,24,3);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    slab(x0, .005, x1, .04, y0, y1, '#6E5540', .6);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({map:t, roughness:.7}));
    m.position.set((x0+x1)/2, (y0+y1)/2, .042); m.receiveShadow = true; room.add(m);
  }
  // Arthur's smithy, where Bixa began: the classic room's sepia photograph (index.html, st.photo) in dark wood
  function smithy(x0, x1){
    const c = document.createElement('canvas'); c.width = 448; c.height = 460; const g = c.getContext('2d'); g.scale(10, 10);
    g.fillStyle='#3A2618';g.fillRect(0,0,44.8,46);const gr=g.createLinearGradient(0,4,0,42);gr.addColorStop(0,'#D9C7A4');gr.addColorStop(1,'#A88E66');g.fillStyle=gr;g.fillRect(3,3,38.8,40);
    g.fillStyle='#5A4632';g.fillRect(8,20,24,20);g.beginPath();g.moveTo(6,20);g.lineTo(20,11);g.lineTo(34,20);g.fill();g.fillRect(27,9,4,9);g.fillStyle='#2E2418';g.fillRect(17,30,7,10);
    g.fillStyle='rgba(90,70,50,.45)';g.beginPath();g.ellipse(30,6,4,2.4,-.3,0,6.283);g.fill();g.fillStyle='#3A2E22';g.fillRect(33,34,6,3);g.fillRect(35,37,2,3);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const y0 = 40/39.2, y1 = 86/39.2;
    slab(x0, .005, x1, .07, y0, y1, '#3A2618', .6);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1-x0, y1-y0), new THREE.MeshStandardMaterial({map:t, roughness:.8}));
    m.position.set((x0+x1)/2, (y0+y1)/2, .072); room.add(m);
  }
  // a low vase of tulips (enhanced room)
  function tulips(x, z){
    const v = new THREE.Mesh(new THREE.CylinderGeometry(.07,.055,.12,16), mat('#E9E4DA', .5));
    v.position.set(x, KK+.06, z); v.castShadow = true; room.add(v);
    const cols = ['#D9464A','#E8B64A','#D9464A','#F2EDE4','#E36A7A'];
    cols.forEach((c, i) => { const a = i/cols.length*6.283, r = .035, lean = .12;
      const tx = x + Math.cos(a)*r*2.2, tz = z + Math.sin(a)*r*2.2, ty = KK + .2 + (i%2)*.04;
      const st = new THREE.Mesh(new THREE.CylinderGeometry(.005,.005,.16,5), mat('#5E8A4E'));
      st.position.set((x+tx)/2, KK+.12+(i%2)*.02, (z+tz)/2); st.lookAt(tx, ty, tz); st.rotateX(Math.PI/2); room.add(st);
      const h = new THREE.Mesh(new THREE.SphereGeometry(.028, 10, 8), new THREE.MeshStandardMaterial({color:c, roughness:.6}));
      h.scale.y = 1.3; h.position.set(tx, ty, tz); room.add(h) });
  }
  // a wall clock that keeps the case's time (enhanced room); frame() turns the hands
  let clockHands = null;
  function wallClock(x, z, y, r){
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = Math.PI/2; room.add(g);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r, r, .04, 40), mat('#2E3338', .4));
    rim.rotation.x = Math.PI/2; rim.position.z = .02; g.add(rim);
    const c = document.createElement('canvas'); c.width = c.height = 128; const k = c.getContext('2d');
    k.fillStyle = '#FBFAF7'; k.beginPath(); k.arc(64,64,62,0,6.283); k.fill(); k.fillStyle = '#2E3338';
    for(let i=0;i<12;i++){ const a = i/12*6.283; k.save(); k.translate(64,64); k.rotate(a); k.fillRect(-2, -56, 4, i%3?8:14); k.restore() }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.CircleGeometry(r*.9, 40), new THREE.MeshStandardMaterial({map:t, roughness:.6}));
    face.position.z = .041; g.add(face);
    const hand = (len, w) => { const p = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, .006), mat('#1C2226', .4));
      m.position.y = len/2 - .02; p.add(m); p.position.z = .046; g.add(p); return p };
    clockHands = {h: hand(r*.5, .018), m: hand(r*.75, .012)};
  }
  // a piece of the classic room's wall art on the left wall (x = 0): {y0, y1, z0, z1, draw(g, w, h)}
  // in 2D wall units, 32 per tile along the wall and 39.2 per tile up. Its left edge is at y1.
  function wallArt(a){
    const w = (a.y1-a.y0)*32, h = a.z1-a.z0, S = 10;
    const c = document.createElement('canvas'); c.width = Math.ceil(w*S); c.height = Math.ceil(h*S);
    const g = c.getContext('2d'); g.scale(S, S); a.draw(g, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const y0 = a.z0/39.2, y1 = a.z1/39.2;
    slab(.005, a.y0, .035, a.y1, y0, y1, '#3A2E24', .6);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(a.y1-a.y0, y1-y0), new THREE.MeshStandardMaterial({map:t, roughness:.7}));
    m.rotation.y = Math.PI/2; m.position.set(.037, (y0+y1)/2, (a.y0+a.y1)/2); m.receiveShadow = true; room.add(m);
  }

  // ------------------------------------------------ helpers shared by the rooms
  const tickers = [];         // per-frame animations of the room (flames), called with the engine's clock
  // light by the classic room's mood: day (default) or dusk (the summer house at 19:40)
  function mood(light){
    if(light==='evening'){                            // a winter night: lamplight, candles and the fire
      hemi.color.set(0xe8d6c4); hemi.groundColor.set(0x5a4a44); hemi.intensity = .7;
      key.color.set(0xffd8a8); key.intensity = 1.15; fill.color.set(0x8aa0d0); fill.intensity = .35;
    }else if(light==='dusk'){
      hemi.color.set(0xf4dcc8); hemi.groundColor.set(0x8a7a86); hemi.intensity = .85;
      key.color.set(0xffd2a0); key.intensity = 1.35; fill.color.set(0xff9a5a); fill.intensity = .75;
    }else{
      hemi.color.set(0xfff6ea); hemi.groundColor.set(0x9aa4ab); hemi.intensity = 1.05;
      key.color.set(0xfff0dc); key.intensity = 1.7; fill.color.set(0xd8e6f2); fill.intensity = .45;
    }
  }
  // vertical boards on a wall, as the classic summer house draws them
  function boards(base, len, h){
    const c = document.createElement('canvas'); c.width = Math.round(len*64); c.height = Math.round(h*64);
    const g = c.getContext('2d'); g.fillStyle = base; g.fillRect(0,0,c.width,c.height);
    for(let u=0; u<c.width; u+=12){ g.fillStyle = 'rgba(120,100,70,.16)'; g.fillRect(u,0,1.4,c.height);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(u+1.4,0,1,c.height) }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  // what the classic room shows through a window: sky (day) or a sunset over the sound
  const views = {};
  function viewTex(kind){
    if(views[kind]) return views[kind];
    const c = document.createElement('canvas'); c.width = 64; c.height = 128; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0,0,0,128);
    if(kind==='sunset'){ [[0,'#8C8FB8'],[.45,'#F0A071'],[.72,'#F8D48E'],[.73,'#3E4A3A'],[.78,'#3E4A3A'],[.79,'#5E7E9A'],[1,'#4A6A88']]
      .forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='fjord'){ [[0,'#9FC3DD'],[.48,'#D6E6EE'],[.55,'#DDE8EC'],[.56,'#7E97A2'],[.63,'#5E7C74'],[.69,'#3E5A50'],[.7,'#7EA6BC'],[1,'#4A7894']]
      .forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='city'){ [[0,'#AFCBDD'],[.7,'#E4EEF3'],[.72,'#9AA8B4'],[1,'#8C9AA6']].forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='lake'){ [[0,'#B8CFDC'],[.5,'#E4ECEE'],[.58,'#E8EEEE'],[.59,'#4E6A4A'],[.66,'#3E5A3E'],[.67,'#9DB8C6'],[1,'#6E90A4']].forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='port'){ [[0,'#5A6772'],[.42,'#96A2AA'],[.52,'#A6B0B6'],[.53,'#3E464E'],[.6,'#4A535B'],[.61,'#566E7E'],[1,'#2C4252']].forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='night'){ [[0,'#101830'],[.6,'#23305A'],[.78,'#3A4468'],[.8,'#1A2030'],[1,'#141A26']].forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='tall'){ [[0,'#5E6F98'],[.45,'#C99A8E'],[.68,'#F2B98A'],[.72,'#F6CFA2'],[.73,'#56627A'],[1,'#3E4E68']].forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else if(kind==='snow'){ [[0,'#1A2440'],[.7,'#34466A'],[.8,'#E8EEF4'],[1,'#F6F8FA']].forEach(([o,cl]) => gr.addColorStop(o, cl)) }
    else { gr.addColorStop(0,'#9CCBE2'); gr.addColorStop(1,'#DCEEF6') }
    g.fillStyle = gr; g.fillRect(0,0,64,128);
    if(kind==='night'){ g.fillStyle = 'rgba(255,230,170,.8)';                    // lit windows across the way
      for(let i=0;i<7;i++) g.fillRect((i*23)%58 + 2, 96 + (i*11)%20, 3, 3) }
    if(kind==='lake'){ g.fillStyle = '#3A5A3A';                                    // the far shore's spruces
      for(let i=0;i<10;i++){ const x = i*6.6 + 2, h = 5 + (i*7)%6; g.beginPath(); g.moveTo(x-3, 76); g.lineTo(x, 76-h); g.lineTo(x+3, 76); g.closePath(); g.fill() }
      g.fillStyle = 'rgba(255,255,255,.35)'; for(let i=0;i<6;i++) g.fillRect((i*19)%56+3, 96 + (i*9)%24, 7, 1) }
    if(kind==='port'){ g.fillStyle = '#353C43';                                    // the old harbour: a crane and a ship
      g.fillRect(44, 36, 2, 32); g.fillRect(34, 36, 20, 2); g.fillRect(50, 38, 1, 10);
      g.fillStyle = '#262B30'; g.beginPath(); g.moveTo(8, 72); g.lineTo(34, 72); g.lineTo(31, 78); g.lineTo(11, 78); g.closePath(); g.fill();
      g.fillRect(24, 66, 6, 6) }
    if(kind==='city'){ g.fillStyle = 'rgba(110,135,160,.55)';                    // Oslo rooftops in winter light
      for(let i=0;i<9;i++){ const w = 4 + (i*7)%6, h = 5 + (i*13)%16; g.fillRect(i*7.4, 92 - h, w, h) } }
    if(kind==='tall'){ g.fillStyle = '#46506A';                                    // the city and the harbour cranes on the skyline
      for(let i=0;i<9;i++){ const w = 4 + (i*7)%6, h = 6 + (i*13)%14; g.fillRect(i*7.4, 92 - h, w, h) }
      g.fillStyle = '#3A4458'; g.fillRect(40, 70, 2, 22); g.fillRect(34, 70, 16, 2); g.fillRect(52, 76, 2, 16); g.fillRect(48, 76, 12, 2);
      g.fillStyle = 'rgba(255,220,160,.8)'; for(let i=0;i<10;i++) g.fillRect((i*17)%60 + 2, 80 + (i*7)%10, 1.5, 1.5) }
    if(kind==='snow'){ g.fillStyle = 'rgba(255,255,255,.85)';                      // falling snow
      for(let i=0;i<40;i++){ const x = (i*37)%64, y = (i*53)%96; g.beginPath(); g.arc(x, y, .8 + (i%3)*.4, 0, 6.283); g.fill() } }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.userData.keep = true; return views[kind] = t;
  }
  function view(kind, x, z, ry){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.24), new THREE.MeshBasicMaterial({map:viewTex(kind)}));
    m.position.set(x, 1.61, z); m.rotation.y = ry; room.add(m);
  }
  // a picture on the back wall (z = 0): {x0, x1, z0, z1, draw(g, w, h)} in the 2D room's wall units
  function backArt(a){
    const w = (a.x1-a.x0)*32, h = a.z1-a.z0, S = 10;
    const c = document.createElement('canvas'); c.width = Math.ceil(w*S); c.height = Math.ceil(h*S);
    const g = c.getContext('2d'); g.scale(S, S); a.draw(g, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const y0 = a.z0/39.2, y1 = a.z1/39.2;
    slab(a.x0, .005, a.x1, .03, y0, y1, '#3A2E24', .6);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(a.x1-a.x0, y1-y0), new THREE.MeshStandardMaterial({map:t, roughness:.7}));
    m.position.set((a.x0+a.x1)/2, (y0+y1)/2, .032); m.receiveShadow = true; room.add(m);
  }
  // a flame that flickers: a warm cone, lit from inside
  const flameMat = [new THREE.MeshBasicMaterial({color:'#FFB347', transparent:true, opacity:.9}),
                    new THREE.MeshBasicMaterial({color:'#FFE08A', transparent:true, opacity:.95})];
  function flame(x, y, z, h, k=0){
    const o = new THREE.Mesh(new THREE.ConeGeometry(h*.28, h, 10), flameMat[0]);
    const i = new THREE.Mesh(new THREE.ConeGeometry(h*.15, h*.6, 8), flameMat[1]); i.position.y = -h*.15;
    o.add(i); o.position.set(x, y + h/2, z); room.add(o);
    tickers.push(t => { const f = 1 + .18*Math.sin(t*9 + k*1.7) + .08*Math.sin(t*23 + k); o.scale.set(1, f, 1) });
    return o;
  }
  function candle(x, y, z){
    const c = new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,.18,14), mat('#F4ECD8', .6));
    c.position.set(x, y+.09, z); c.castShadow = true; room.add(c);
    flame(x, y+.19, z, .06, x*3+z);
  }
  // a bouquet in a glass vase: stems and round flowers in the given colours
  function bouquet(x, y, z, cols, vase='#BFD7E0'){
    const v = new THREE.Mesh(new THREE.CylinderGeometry(.06,.05,.2,16),
      new THREE.MeshStandardMaterial({color:vase, transparent:true, opacity:.6, roughness:.1}));
    v.position.set(x, y+.1, z); room.add(v);
    cols.forEach((c, i) => { const a = i/cols.length*6.283, r = .07 + (i%2)*.03;
      const tx = x + Math.cos(a)*r, tz = z + Math.sin(a)*r, ty = y + .3 + (i%3)*.04;
      const st = new THREE.Mesh(new THREE.CylinderGeometry(.004,.004,.2,5), mat('#6E8A4E'));
      st.position.set((x+tx)/2, (y+.2+ty)/2, (z+tz)/2); st.lookAt(tx, ty, tz); st.rotateX(Math.PI/2); room.add(st);
      const h = new THREE.Mesh(new THREE.SphereGeometry(.03, 10, 8), new THREE.MeshStandardMaterial({color:c, roughness:.7}));
      h.position.set(tx, ty, tz); room.add(h) });
  }
  // kanelbullar on a plate
  function bunPlate(x, y, z){
    const p = new THREE.Mesh(new THREE.CylinderGeometry(.2,.17,.02,28), mat('#FFFFFF', .4));
    p.position.set(x, y+.01, z); room.add(p);
    [[-.08,-.02],[.07,-.05],[0,.07],[-.02,-.09],[.09,.06]].forEach(([dx,dz]) => {
      const b = new THREE.Mesh(new THREE.SphereGeometry(.055, 14, 10), mat('#B8743E', .7));
      b.scale.set(1, .6, 1); b.position.set(x+dx, y+.045, z+dz); b.castShadow = true; room.add(b) });
  }

  // a chair cushion in a colour (the julbord's red seats)
  function cushion(x, z, ry, color){
    const m = new THREE.Mesh(new THREE.BoxGeometry(.4, .035, .38), mat(color, .9));
    m.position.set(x, SEAT_Y + .02, z); m.rotation.y = ry; m.castShadow = true; room.add(m);
  }
  // a flat rug with a light inner border line, as the classic rooms draw theirs
  function rug(x0, z0, x1, z1, color){
    const w = x1-x0, d = z1-z0, c = document.createElement('canvas'); c.width = Math.round(w*64); c.height = Math.round(d*64);
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0,0,c.width,c.height);
    g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 2; g.strokeRect(8,8,c.width-16,c.height-16);
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 3; g.strokeRect(18,18,c.width-36,c.height-36);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, .02, d), new THREE.MeshStandardMaterial({map:t, roughness:1}));
    m.position.set((x0+x1)/2, .01, (z0+z1)/2); m.receiveShadow = true; room.add(m);
  }
  // the classic fireplace on the left wall (x .08..0.62, y 2.35..4.65, 68 up), with a live fire
  function fireplace(){
    const FP = '#ECE7DE';
    slab(0, 2.35, .62, 3.03, 0, 1.68, FP, .95); slab(0, 3.96, .62, 4.65, 0, 1.68, FP, .95);
    slab(0, 3.03, .62, 3.96, 1.02, 1.68, FP, .95);
    slab(.6, 2.35, .63, 4.65, 1.53, 1.6, '#D9D2C6', .9);
    slab(0, 3.03, .14, 3.96, 0, 1.02, '#2A2220', 1); slab(0, 3.03, .62, 3.96, 0, .02, '#2A2220', 1);
    slab(.1, 3.03, .62, 3.06, 0, 1.02, '#3A302C', 1); slab(.1, 3.93, .62, 3.96, 0, 1.02, '#3A302C', 1);
    slab(.62, 2.9, .98, 4.1, 0, .035, '#B9B0A2', .9);                              // the hearth
    slab(.06, 2.2, .72, 4.8, 1.68, 1.79, '#D9CFC0', .8);                             // the mantel
    slab(.12, 2.6, .3, 2.8, 1.79, 2.15, '#3F6E73', .5); candle(.21, 1.79, 4.2);
    for(const [z, r] of [[3.35, .3], [3.6, -.25]]){
      const l = new THREE.Mesh(new THREE.CylinderGeometry(.05,.05,.55,10), mat('#6B4A30'));
      l.rotation.z = Math.PI/2; l.rotation.y = r; l.position.set(.36, .07, z); room.add(l) }
    for(let k=0; k<5; k++) flame(.34 + (k%2)*.06, .08, 3.2 + k*.13, .34 + (k%3)*.08, k);
    const fire = new THREE.PointLight(0xff9a4a, 2.2, 5, 1.6); fire.position.set(.9, .55, 3.5); room.add(fire);
    tickers.push(t => { fire.intensity = 2.0 + .5*Math.sin(t*7) + .3*Math.sin(t*17) });
  }
  // a Christmas tree: a red pot, four tiers, twinkling lights, baubles and a star (classic xmasTree())
  function xmasTree(x, z){
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(.24,.2,.34,16), mat('#8A3B34', .7));
    pot.position.set(x, .17, z); pot.castShadow = true; room.add(pot);
    const green = ['#3F7A4E','#2E5E3E','#3F7A4E','#2E5E3E'];
    for(let k=0; k<4; k++){ const r = .78 - k*.16, h = .8 - k*.08, y = .38 + k*.46;
      const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 9), new THREE.MeshStandardMaterial({color:green[k], roughness:.9, flatShading:true}));
      c.position.set(x, y + h/2, z); c.castShadow = true; room.add(c) }
    const cols = ['#FFD27A','#FF8A6A','#FFF4D0','#9AD0FF'], bulbs = [];
    for(let k=0; k<30; k++){ const t = k/30, y = .5 + t*1.75, r = (1-t)*.62 + .06, a = k*2.4;
      const b = new THREE.Mesh(new THREE.SphereGeometry(.028, 8, 6), new THREE.MeshBasicMaterial({color:cols[k%4]}));
      b.position.set(x + Math.cos(a)*r, y, z + Math.sin(a)*r); room.add(b); bulbs.push(b) }
    tickers.push(t => bulbs.forEach((b, k) => { b.visible = Math.sin(t*3 + k*1.7) > -.2 }));
    [[-.4,.9,.2,'#C9302C'],[.35,1.3,.25,'#E3BD62'],[-.15,1.75,-.3,'#3F7FBF'],[.45,.7,-.3,'#E3BD62'],[-.5,.65,-.2,'#E3BD62'],[.2,1.05,.45,'#C9302C']]
      .forEach(([dx,y,dz,c]) => { const b = new THREE.Mesh(new THREE.SphereGeometry(.055, 12, 10), new THREE.MeshStandardMaterial({color:c, roughness:.25, metalness:.4}));
        b.position.set(x+dx, y, z+dz); room.add(b) });
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(.1), new THREE.MeshBasicMaterial({color:'#FFE08A'}));
    star.position.set(x, 2.45, z); star.scale.set(1, 1.2, .5); room.add(star);
    const glow = new THREE.PointLight(0xffd9a0, .9, 3, 1.8); glow.position.set(x, 1.4, z + .5); room.add(glow);
  }
  // julbord dishes on white platters: salmon, herring, saffron buns (lussekatter), the ham
  function platter(x, y, z, kind){
    const p = new THREE.Mesh(new THREE.CylinderGeometry(.24,.2,.025,28), mat('#FBFAF6', .35));
    p.scale.z = .62; p.position.set(x, y+.012, z); room.add(p);
    const put = (dx, dz, geo, c, sy=1) => { const m = new THREE.Mesh(geo, mat(c, .6)); m.scale.y = sy; m.position.set(x+dx, y+.035, z+dz); room.add(m) };
    if(kind==='salmon') for(let k=0;k<6;k++) put(-.15+k*.06, (k%2?.02:-.02), new THREE.BoxGeometry(.05,.025,.09), k%2?'#F29A7A':'#E8836A');
    if(kind==='herring') [[-.1,'#E9E2CC'],[0,'#D9A6A8'],[.1,'#E9D9A8']].forEach(([dx,c]) => put(dx, 0, new THREE.CylinderGeometry(.045,.045,.04,14), c));
    if(kind==='saffron') for(let k=0;k<6;k++) put(-.1+(k%3)*.1, Math.floor(k/3)*.07-.035, new THREE.SphereGeometry(.035,10,8), '#E9B54A', .55);
    if(kind==='ham'){ put(0, 0, new THREE.SphereGeometry(.12,16,12), '#C8764A', .6) }
  }
  function plate(x, y, z){
    const p = new THREE.Mesh(new THREE.CylinderGeometry(.11,.09,.015,24), mat('#FFFFFF', .3)); p.position.set(x, y+.008, z); room.add(p);
    const r = new THREE.Mesh(new THREE.TorusGeometry(.085,.004,6,28), mat('#C9A55A', .4)); r.rotation.x = Math.PI/2; r.position.set(x, y+.017, z); room.add(r);
  }
  function glogg(x, y, z){
    const g = new THREE.Mesh(new THREE.CylinderGeometry(.03,.028,.09,14), new THREE.MeshStandardMaterial({color:'#EBF0F5', transparent:true, opacity:.45, roughness:.1, depthWrite:false}));
    g.position.set(x, y+.045, z); room.add(g);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(.026,.025,.06,14), mat('#7A1E24', .3)); w.position.set(x, y+.032, z); room.add(w);
  }
  function candelabra(x, y, z){
    slab(x-.12, z-.04, x+.12, z+.04, y, y+.03, '#C9A55A', .3);
    for(const dx of [-.1, 0, .1]) candle(x+dx, y+.03, z);
  }
  // a pine runner down the table with red berries (classic pineRunner())
  function pineRunner(y){
    for(let k=0; k<18; k++){ const x = 2.55 + k*.29, z = 3.5 + Math.sin(k*1.7)*.07;
      if(Math.abs(x-3.8)<.2 || Math.abs(x-6.2)<.2) continue;
      const m = new THREE.Mesh(new THREE.ConeGeometry(.05, .2, 6), new THREE.MeshStandardMaterial({color:k%2?'#2E5E3E':'#3F7A4E', roughness:.9, flatShading:true}));
      m.rotation.z = Math.PI/2; m.rotation.y = k*.7; m.position.set(x, y+.03, z); room.add(m);
      if(k%3===0){ const b = new THREE.Mesh(new THREE.SphereGeometry(.018, 8, 6), mat('#C9302C', .4)); b.position.set(x+.04, y+.05, z-.02); room.add(b) } }
  }

  // ---- the julbord spread: generous dishes, piled high so they read from the room camera
  function bowl(x, y, z, r, color='#FBFAF6'){
    const b = new THREE.Mesh(new THREE.CylinderGeometry(r, r*.72, r*.55, 24, 1, true), new THREE.MeshStandardMaterial({color, roughness:.35, side:THREE.DoubleSide}));
    b.position.set(x, y + r*.275, z); b.castShadow = true; room.add(b);
    const f = new THREE.Mesh(new THREE.CircleGeometry(r*.72, 20), mat(color, .35)); f.rotation.x = -Math.PI/2; f.position.set(x, y+.004, z); room.add(f);
    return y + r*.35;                                 // where the food sits
  }
  function heap(x, y, z, n, rad, spread, color, sy=1, seed=1){  // n round bits piled into a mound
    const g = new THREE.SphereGeometry(rad, 10, 8), m = mat(color, .7);
    for(let i=0; i<n; i++){ const a = i*2.4 + seed, f = Math.sqrt((i+.5)/n), d = spread*f;
      const o = new THREE.Mesh(g, m); o.scale.y = sy; o.position.set(x + Math.cos(a)*d, y + (1-f)*rad*2.2*sy, z + Math.sin(a)*d); room.add(o) }
  }
  function flatPlate(x, y, z, r, sz=1){
    const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r*.85, .018, 26), mat('#FBFAF6', .3)); p.scale.z = sz; p.position.set(x, y+.009, z); room.add(p);
    return y + .018;
  }
  // a two-tier cake stand with saffron buns below and pepparkakor above
  function cakeStand(x, y, z){
    const M = mat('#FBFAF6', .3), post = new THREE.Mesh(new THREE.CylinderGeometry(.012,.012,.26,8), mat('#C9A55A', .3));
    post.position.set(x, y+.13, z); room.add(post);
    for(const [h, r] of [[.02, .15], [.17, .1]]){ const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r*.9, .014, 26), M); t.position.set(x, y+h, z); t.castShadow = true; room.add(t) }
    heap(x, y+.035, z, 9, .03, .1, '#E9B54A', .6);
    for(let i=0;i<7;i++){ const a = i*.9, d = i ? .055 : 0; const c = new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,.008,10), mat('#9A5A2E', .7));
      c.position.set(x + Math.cos(a)*d, y+.185 + i*.006, z + Math.sin(a)*d); c.rotation.x = .2*(i%2); room.add(c) }
    const top = new THREE.Mesh(new THREE.SphereGeometry(.018, 8, 6), mat('#C9A55A', .3)); top.position.set(x, y+.27, z); room.add(top);
  }
  function spread(T){
    const WH = '#FBFAF6';
    // Jansson's temptation: a deep white gratin dish with a golden, crusted top
    slab(2.68, 3.62, 3.14, 3.98, T, T+.1, WH, .3);
    heap(2.91, T+.08, 3.8, 14, .05, .15, '#D9A24E', .4, 2);
    // köttbullar and prinskorv
    heap(3.35, bowl(3.35, T, 3.27, .15), 3.27, 20, .034, .1, '#7A4A2A');
    { const y = flatPlate(3.35, T, 3.8, .16, .75);
      for(let i=0;i<10;i++){ const c = new THREE.Mesh(new THREE.CapsuleGeometry(.018,.07,4,8), mat('#B8583A', .5)); c.rotation.z = Math.PI/2; c.rotation.y = .2 + i*.1;
        c.position.set(3.35 + (i%2 ? .04 : -.04), y + .02 + (i%3)*.012, 3.72 + i*.018); room.add(c) } }
    // beetroot salad, heaped
    heap(4.33, bowl(4.33, T, 3.24, .14), 3.24, 16, .036, .09, '#B83A6A', .7);
    // the Christmas ham on a board: big, glazed, with mustard
    slab(4.72, 3.08, 5.36, 3.46, T, T+.03, '#A0703C', .6);
    { const h = new THREE.Mesh(new THREE.SphereGeometry(.2, 20, 16), mat('#C8764A', .6)); h.scale.set(1.3, .75, .85); h.position.set(5.04, T+.14, 3.27); h.castShadow = true; room.add(h);
      const t = new THREE.Mesh(new THREE.SphereGeometry(.2, 20, 16, 0, 6.283, 0, 1.05), mat('#E3BD62', .45)); t.scale.set(1.26, .76, .82); t.position.set(5.04, T+.142, 3.27); room.add(t);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,.07,14), mat('#E0B43A', .5)); m.position.set(5.3, T+.065, 3.42); room.add(m) }
    // boiled potatoes with dill
    heap(5.1, bowl(5.1, T, 3.8, .15), 3.8, 16, .042, .1, '#E8D29A', .85);
    heap(5.1, T+.13, 3.8, 7, .012, .08, '#5E8A3E', 1, 3);
    // eggs with shrimp, two rows on a long plate
    { const y = flatPlate(5.74, T, 3.8, .17, .7);
      for(let i=0;i<8;i++){ const x = 5.62 + (i%4)*.08, z = 3.75 + Math.floor(i/4)*.1;
        const e = new THREE.Mesh(new THREE.SphereGeometry(.032, 10, 6, 0, 6.283, 0, 1.57), mat('#FBF8F0', .5)); e.rotation.x = Math.PI; e.position.set(x, y+.03, z); room.add(e);
        const yk = new THREE.Mesh(new THREE.CircleGeometry(.017, 10), mat('#F2C230', .6)); yk.rotation.x = -Math.PI/2; yk.position.set(x, y+.031, z); room.add(yk);
        const sh = new THREE.Mesh(new THREE.TorusGeometry(.012,.005,5,8,4.5), mat('#F08A7A', .5)); sh.rotation.x = -Math.PI/2; sh.position.set(x, y+.038, z); room.add(sh) } }
    // red cabbage
    heap(6.6, bowl(6.6, T, 3.24, .14), 3.24, 16, .034, .09, '#6E2E5A', .6);
    // a cheese board with three wedges
    slab(6.43, 3.64, 6.87, 3.94, T, T+.025, '#B98A5A', .6);
    for(const [dx,dz,c] of [[-.11,0,'#F2D478'],[.04,-.05,'#EFE3B8'],[.12,.06,'#F2C85A']]){
      const w = new THREE.Mesh(new THREE.CylinderGeometry(.075,.075,.07,3), mat(c, .7)); w.position.set(6.65+dx, T+.06, 3.79+dz); w.rotation.y = dx*9; room.add(w) }
    // a bread basket: knäckebröd standing up, and a dark loaf
    { const y = bowl(7.45, T, 3.24, .15, '#B8844A');
      for(let i=0;i<5;i++){ const k = new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,.01,12), mat('#D8B070', .8)); k.rotation.x = 1.3; k.rotation.z = i*.3-.6;
        k.position.set(7.38 + i*.03, y+.05, 3.2); room.add(k) }
      const l = new THREE.Mesh(new THREE.CapsuleGeometry(.05,.1,4,8), mat('#5A3A24', .8)); l.rotation.z = Math.PI/2; l.position.set(7.5, y+.03, 3.3); room.add(l) }
    // ris à la Malta with red berry sauce
    { const y = bowl(7.5, T, 3.8, .13);
      const r = new THREE.Mesh(new THREE.SphereGeometry(.1, 16, 8, 0, 6.283, 0, 1.2), mat('#FBF6EC', .6)); r.position.set(7.5, y-.03, 3.8); room.add(r);
      heap(7.5, y+.04, 3.8, 7, .016, .04, '#B8202A') }
    // lingonberries by the meatballs, pickled cucumber by the cheese
    heap(3.74, bowl(3.74, T, 3.82, .08), 3.82, 12, .014, .05, '#9A1E2A');
    heap(6.22, bowl(6.22, T, 3.82, .08), 3.82, 8, .02, .045, '#8AA04A', .5);
    // two cake stands on the runner; julmust at both ends of the table
    cakeStand(4.05, T, 3.5); cakeStand(6.95, T, 3.5);
    for(const x of [2.52, 7.28]){ const b = new THREE.Mesh(new THREE.CylinderGeometry(.034,.038,.25,14), mat('#3A1E14', .2)); b.position.set(x, T+.125, 3.5); b.castShadow = true; room.add(b);
      const n = new THREE.Mesh(new THREE.CylinderGeometry(.014,.021,.07,10), mat('#3A1E14', .2)); n.position.set(x, T+.285, 3.5); room.add(n);
      const lab = new THREE.Mesh(new THREE.CylinderGeometry(.0385,.0385,.075,14), mat('#C9302C', .6)); lab.position.set(x, T+.1, 3.5); room.add(lab) }
    // pepparkakor for the children
    { const y = flatPlate(5.0, T, 4.13, .12);
      if(pieces.gingerbread_man) for(let i=0;i<4;i++) place('gingerbread_man', 4.95 + (i%2)*.1, 4.08 + Math.floor(i/2)*.1, i*.7, y + i*.006, .13) }
  }
  const ROOMS = {};
  // The one boardroom footprint every case shares: x 0..10, z 0..7, drawn as a cut-away: two tall
  // walls on the far sides (z=0, x=0), the near sides open, no corridor. The engine's door (x 5..6
  // on the z=7 side) stays where it is; people crossing that edge fade in and out (see fadeAt).
  ROOMS.board = (RS, opt={}) => {
    const wood = RS.tex==='stone' ? stone(RS.floor) : RS.tex==='tile' ? tiles(RS.floor) : planks(RS.floor||'#D9B98A', '#8A6A48');
    wood.repeat.set(5, 3.5);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(10, 7), new THREE.MeshStandardMaterial({map:wood, roughness:.8}));
    fl.rotation.x = -Math.PI/2; fl.position.set(5, 0, 3.5); fl.receiveShadow = true; room.add(fl);
    const W = RS.wall||['#F7F5F0','#FBFAF7'], WH = 2.65, T = .12;
    slab(-T,-T,10,7, -.22,-.002, (RS.slab||['#C9BA9F'])[0], .9);  // the floor's cut edge on the open sides
    const bw = slab(0,-T,10,0, 0,WH, W[0], 1);         // back wall, along x
    const lw = slab(-T,0,0,7,  0,WH, W[1]||W[0], 1);   // left wall, along z
    if(RS.planks){                                     // the summer house's board walls
      bw.material = new THREE.MeshStandardMaterial({map:boards(W[0], 10, WH), roughness:1});
      lw.material = new THREE.MeshStandardMaterial({map:boards(W[1]||W[0], 7, WH), roughness:1});
    }
    for(const a of RS.backArt||[]) backArt(a);        // the back wall's pictures, drawn by the 2D room's code
    // The near walls (x = 10, z = 7) the cut-away leaves out. A close-up looking that way would see past the
    // floor's edge into nothing, so they exist for the portrait camera only, once it is inside the room
    // (frame() shows them), and cast no shadow. The front wall keeps the engine's doorway at x 5..6, with a door.
    nearWalls = new THREE.Group(); room.add(nearWalls);
    const near = m => { m.castShadow = false; nearWalls.add(m); return m };
    const nw = (x0,z0,x1,z1,len,col) => { const m = near(slab(x0,z0,x1,z1, 0,WH, col, 1));
      if(RS.planks) m.material = new THREE.MeshStandardMaterial({map:boards(col, len, WH), roughness:1}) };
    nw(10,0,10+T,7, 7, W[3]||W[0]); nw(0,7,5,7+T, 5, W[2]||W[0]); nw(6,7,10,7+T, 4, W[2]||W[0]);
    near(slab(5,7,6,7+T, 2.05,WH, W[2]||W[0], 1));
    if(RS.wains){ for(const [x0,z0,x1,z1,n] of [[9.975,0,10,7,7],[0,6.975,5,7,5],[6,6.975,10,7,4]]){
      const m = near(slab(x0,z0,x1,z1, 0,DADO, RS.wains[0], .85)); const t = wainscot(RS.wains[0], RS.wains[1]); t.repeat.set(n, 1);
      m.material = new THREE.MeshStandardMaterial({map:t, roughness:.85}) } }
    const nb = (RS.base||['#D8D0C3'])[0];
    near(slab(9.95,0,10,7, 0,.1, nb, .7)); near(slab(0,6.95,5,7, 0,.1, nb, .7)); near(slab(6,6.95,10,7, 0,.1, nb, .7));
    if(pieces.door_light_oak){ const d = place('door_light_oak', 5.5, 7.02, Math.PI, 0, [1.08, 1, 1], {shadow:false}); nearWalls.add(d) }
    for(const a of RS.leftArt||[]) wallArt(a);        // the left wall's art, drawn by the same code as the 2D room
    if(RS.wains){                                      // the classic room's panelled dado, one panel per tile
      const mk = n => { const t = wainscot(RS.wains[0], RS.wains[1]); t.repeat.set(n, 1); return t };
      const dado = (x0,z0,x1,z1,n) => { const m = slab(x0,z0,x1,z1, 0,DADO, RS.wains[0], .85);
        m.material = new THREE.MeshStandardMaterial({map:mk(n), roughness:.85}) };
      dado(0,0,10,.025, 10); dado(0,0,.025,7, 7);
    }
    const base = (RS.base||['#D8D0C3'])[0];
    slab(0,0,10,.05, 0,.1, base, .7); slab(0,0,.05,7, 0,.1, base, .7);
    // windows as in the classic room: back wall tiles 0-3 and 6-9, left wall tiles 0-1 and 5-6,
    // glass from z 36 to 90 (0.92 to 2.30 up). Each Nordic window spans two tiles.
    if(pieces.large_nordic_window){
      const sx = 1.64/1.7, sy = 1.38/1.245, y = .92 - .1275*sy;
      const vk = opt.view || RS.win;
      if(opt.windows!==false) for(const x of opt.back || [1, 3, 7, 9]){ place('large_nordic_window', x, .05, 0, y, [sx, sy, 1], {shadow:false});
        view(vk, x, .016, 0) }
      if(!RS.leftBlank && opt.left!==false && opt.windows!==false) for(const z of [1, 6]){ place('large_nordic_window', .05, z, Math.PI/2, y, [sx, sy, 1], {shadow:false});
        view(vk, .016, z, Math.PI/2) }
    }
  };
  // Lindqvist and every other case in the default boardroom: the classic room's layout, piece by
  // piece (index.html, furnish(): the 'office' branch), in KayKit and Nordic Cast models.
  // KayKit pieces take KK like the cast; Nordic pieces are authored in metres, one tile each.
  // o (for a room in the same layout, Eriksson's): rug colour, table top colour, chair and cushion
  ROOMS.boardroom = (RS, o={}) => {
    ROOMS.board(RS);
    const TOP = KK;                                    // the table top, one KayKit unit up
    if(o.rug) rug(1.1, 1.55, 8.9, 5.45, o.rug);
    else place('rug_rectangle_B', 5, 3.5, 0, .005, [KK*3.33, KK, KK*2.5], {shadow:false});  // 1.1..8.9 x 1.55..5.45
    place('table_medium_long', 3.6, 3.5, 0, 0, [KK*1.197, KK, KK]);                    // 2.2..7.8 x 2.72..4.28
    place('table_medium_long', 6.4, 3.5, 0, 0, [KK*1.197, KK, KK]);
    if(o.top) slab(2.18, 2.7, 7.82, 4.3, TOP-.02, TOP+.003, o.top, .35);
    if(o.chair){ chairName = o.chair; chairCushion = o.cushion || null }
    // the walnut credenza on the back wall (3.1..6.9, 0.12..0.6), the painting above it
    for(const x of [4.05, 5.95]) place('cabinet_medium', x, .36, 0, 0, [.95, .66, .48]);
    // on the credenza (enhanced): a lamp at each end, a vase, a framed photo, books, a small cactus
    const CT = .66;
    place('lamp_table', 3.4, .34, 0, CT, KK*.55); place('lamp_table', 6.62, .34, 0, CT, KK*.55);
    place('ceramic_vase', 3.95, .36, 0, CT, 1);
    place('pictureframe_standing_B', 6.1, .3, -.25, CT, KK*.55);
    place('book_set', 5.55, .36, 0, CT + .25*KK*.5, KK*.5);
    place('cactus_small_A', 4.45, .36, 0, CT, KK*.5);
    if(o.photo) smithy(4.3, 5.7); else painting(4.1, 5.9, .92, 2.25);                  // 4.1..5.9, z 36..88
    // the screen on the left wall (y 2.55..4.45, z 36..66)
    slab(.02,2.55,.08,4.45, .92,1.68, '#2E3338', .4);
    slab(.08,2.62,.085,4.38, .96,1.64, '#1C2226', .15);
    // under the screen (enhanced): a slim bench with a basket, a plant and a book; above it a wall clock
    for(const z of [3.05, 3.95]) place('cabinet_small', .19, z, Math.PI/2, 0, [.9, .45, .36]);
    place('woven_basket', .2, 2.85, 0, .45, .55); place('cactus_small_B', .2, 4.2, 0, .45, KK*.45);
    place('book_single', .2, 3.6, Math.PI/2, .45 + .25*KK*.45, KK*.45);
    wallClock(.02, 3.5, 2.12, .2);
    // the corners and the open side (enhanced): a floor lamp by the windows, a coffee trolley
    place('slim_floor_lamp', .32, .32, 0, 0, 1);
    place('serving_trolley', 9.45, 1.55, -Math.PI/2, 0, 1);
    place('coffee_mug', 9.35, 1.35, 0, .73, .8); place('coffee_mug', 9.52, 1.62, 0, .73, .8);
    // the two plants of the classic room
    plant(9.45, .55, 1.1); plant(.55, 5.45, .9);
    // on the table: laptops for the far row, papers at every place, a carafe, mugs, a tablet
    place('laptop', 4.5, 3.2, 0, TOP, 1); place('laptop', 6.5, 3.2, 0, TOP, 1);
    const paper = (x0,z0,x1,z1) => slab(x0,z0,x1,z1, TOP,TOP+.012, '#FBFBF8', .9);
    for(const x of [3.5, 4.5, 5.5, 6.5]){ if(x!==4.5 && x!==6.5) paper(x-.12,2.82,x+.12,3.03); paper(x-.12,3.97,x+.12,4.18) }
    paper(2.3,3.38,2.52,3.62); paper(7.48,3.38,7.7,3.62);
    slab(4.3,3.98,4.7,4.22, TOP,TOP+.02, '#2E4A5A', .3);
    { const g = new THREE.Mesh(new THREE.CylinderGeometry(.055,.06,.3,20),
        new THREE.MeshStandardMaterial({color:'#D6E6EA', transparent:true, opacity:.55, roughness:.1, depthWrite:false}));
      g.position.set(5, TOP+.15, 3.5); room.add(g) }
    place('coffee_mug', 4.6, 3.4, 0, TOP, .8); place('coffee_mug', 5.4, 3.6, 0, TOP, .8);
    place('coffee_mug', 2.43, 3.29, 0, TOP, .8);
    // (enhanced) a water glass and a notepad with a pen at every place; tulips down the middle
    const glassMat = new THREE.MeshStandardMaterial({color:'#DCEBF0', transparent:true, opacity:.5, roughness:.05, depthWrite:false});
    const glass = (x, z) => { const g = new THREE.Mesh(new THREE.CylinderGeometry(.03,.026,.1,14), glassMat);
      g.position.set(x, TOP+.05, z); room.add(g) };
    const pad = (x, z) => { slab(x-.08,z-.1,x+.08,z+.1, TOP,TOP+.015, '#F1EDE2', .9);
      const pen = slab(x+.1,z-.08,x+.115,z+.08, TOP,TOP+.012, '#27313A', .4) };
    for(const x of [3.5, 4.5, 5.5, 6.5]){ glass(x+.2, 2.95); glass(x-.2, 4.05);
      if(x!==4.5 && x!==6.5) pad(x+.02, 3.18); pad(x-.02, 3.82) }
    glass(2.45, 3.7); glass(7.55, 3.3); pad(2.62, 3.5); pad(7.38, 3.5);
    tulips(3.9, 3.5); tulips(6.1, 3.5);
  };

  // Stenberg's summer house outside Malmö, after the classic 'summer' room (index.html, furnish()):
  // the kitchen table for five, the fireplace on the left wall, a reading corner with sofa, armchair
  // and floor lamp, low bookshelves under the back windows, and the sunset over the sound.
  ROOMS.summer = (RS) => {
    ROOMS.board(RS);
    const TOP = KK;
    // the blue rug under the table (1.25..5.95 x 1.95..5.05) and a woven one in the corner
    place('rug_rectangle_B', 3.6, 3.5, 0, .005, [4.7/3, KK, 3.1/2], {shadow:false});
    place('soft_woven_rug', 7.65, 4.85, 0, .005, [2.6/1.8, 1, 2.2/1.2], {shadow:false});
    // the birch table (2.2..5.3 x 2.72..4.28), a Nordic dining table stretched to the classic size
    place('rectangular_dining_table_6', 3.75, 3.5, 0, 0, [3.1/2, TOP/.75, 1.56/.92]);
    fireplace();                                                                     // with a teal vase and a candle on the mantel
    // (enhanced) a log basket by the fireplace
    place('woven_basket', .45, 5.0, 0, 0, .75);
    for(const dz of [-.06, .06]){ const l = new THREE.Mesh(new THREE.CylinderGeometry(.05,.05,.42,10), mat('#7A5A3E'));
      l.rotation.x = Math.PI/2; l.position.set(.45 + dz, .3, 5.0); room.add(l) }
    // low bookshelves under the back windows (the classic shelf, 6.3..8.7 along the wall)
    for(const x of [6.9, 8.1]){ place('open_office_shelf', x, .22, 0, 0, [.95, .55, 1]);
      place('book_set', x - .25, .22, 0, .43 + .25*KK*.45, KK*.45); place('book_set', x + .28, .22, 0, .02 + .25*KK*.45, KK*.45) }
    place('ceramic_vase', 7.5, .22, 0, .86, 1);
    // the reading corner: sofa facing the back wall, coffee table, armchair toward the table, lamp
    // (Nordic Cast pieces face -z: the sofa looks at the back wall as is, the armchair turns a quarter)
    place('compact_sofa', 7.55, 5.5, 0, 0, 1.1);
    place('pillow_A', 6.95, 5.72, -.15, .5, KK*.6); place('pillow_B', 8.15, 5.72, .15, .5, KK*.6);
    place('throw_blanket_folded', 7.9, 5.35, .3, .47, 1);
    place('round_coffee_table', 7.55, 4.35, 0, 0, [1.2, 1, .8]);
    candle(7.2, .42, 4.3);
    slab(7.6, 4.15, 7.95, 4.45, .42, .46, '#3F6E73', .6);                             // a book
    place('nordic_lounge_chair', 8.55, 2.9, Math.PI/2, 0, 1.1);
    place('lamp_standing', 8.3, 2.15, 0, 0, KK);                    // beside the armchair: clear of the view and of the path along the wall
    const lampL = new THREE.PointLight(0xffd9a0, 1.2, 3.5, 1.8); lampL.position.set(8.3, 1.25, 2.15); room.add(lampL);
    // the plants
    plant(9.45, .55, 1.0, '#E9E4DA'); plant(.55, 5.45, 1.1, '#E9E4DA');
    // the table: mugs, kanelbullar, two candles, a bouquet of summer flowers, papers
    place('coffee_mug', 2.6, 3.35, 0, TOP, .8); place('coffee_mug', 3.5, 3.02, 0, TOP, .8);
    place('coffee_mug', 4.5, 3.02, 0, TOP, .8); place('coffee_mug', 4.5, 3.98, 0, TOP, .8);
    bunPlate(3.95, TOP, 3.6);
    candle(4.95, TOP, 3.3); candle(4.95, TOP, 3.75);
    bouquet(2.85, TOP, 3.85, ['#F4F1EA','#E9C54A','#8E7CC3','#F4F1EA','#D96A5A','#8E7CC3']);
    slab(3.2, 3.85, 3.55, 4.1, TOP, TOP+.012, '#FBFBF8', .9);
  };

  // Sjöstrand's julbord, after the classic 'julbord' room: the boardroom's table for ten under a white
  // cloth, red seats, the fireplace, the tree in the corner, the sideboard with the ham, a snowy night.
  ROOMS.julbord = (RS) => {
    ROOMS.board(RS);
    const TOP = KK;
    rug(1.1, 1.55, 8.9, 5.45, '#7A2A28');
    place('table_medium_long', 3.6, 3.5, 0, 0, [KK*1.197, KK, KK]);                    // 2.2..7.8 x 2.72..4.28
    place('table_medium_long', 6.4, 3.5, 0, 0, [KK*1.197, KK, KK]);
    // the white tablecloth, falling a hand's width over the edges
    const CL = '#F6F3EC';
    slab(2.12, 2.64, 7.88, 4.36, TOP+.002, TOP+.014, CL, .9);
    slab(2.12, 2.64, 7.88, 2.66, TOP-.2, TOP+.014, CL, .9); slab(2.12, 4.34, 7.88, 4.36, TOP-.2, TOP+.014, CL, .9);
    slab(2.12, 2.64, 2.14, 4.36, TOP-.2, TOP+.014, CL, .9); slab(7.86, 2.64, 7.88, 4.36, TOP-.2, TOP+.014, CL, .9);
    const T = TOP + .014;
    chairName = 'chair_A_wood'; chairCushion = '#7A2E2A';
    fireplace();
    // (enhanced) a pine garland with red berries along the mantel
    for(let k=0; k<11; k++){ const z = 2.3 + k*.23;
      const m = new THREE.Mesh(new THREE.ConeGeometry(.06, .24, 6), new THREE.MeshStandardMaterial({color:k%2?'#2E5E3E':'#3F7A4E', flatShading:true}));
      m.rotation.x = Math.PI/2; m.rotation.z = k; m.position.set(.68, 1.72, z); room.add(m);
      if(k%2===0){ const b = new THREE.Mesh(new THREE.SphereGeometry(.03, 8, 6), mat('#C9302C', .4)); b.position.set(.72, 1.7, z+.05); room.add(b) } }
    // (KayKit Holiday Bits) the decorated tree with its gifts, more presents, a wreath, a bell on the
    // mantel, a gingerbread house on the sideboard, and a red wingback chair by the fire
    if(pieces.christmas_tree_decorated){
      place('christmas_tree_decorated', 9.1, 1.0, -.4, 0, .58);
      const glow = new THREE.PointLight(0xffd9a0, .9, 3, 1.8); glow.position.set(9.1, 1.4, 1.5); room.add(glow);
      place('present_A_red', 8.3, 1.6, .3, 0, .38); place('present_B_green', 8.72, 1.95, -.2, 0, .34);
      place('present_C_white', 9.62, 1.98, .5, 0, .36); place('present_sphere_A_yellow', 8.05, 1.15, 0, .307*.34, .34);
    } else xmasTree(9.1, 1.0);
    place('wreath', .1, 2.08, Math.PI/2, 2.2, .34);                                  // on the wall, above the mantel's end
    place('bell_decorated', .22, 2.97, Math.PI/2, 1.79 + .517*.28, .28);
    place('gingerbread_house_decorated', 5.2, .36, -.3, .71, .18);
    const fx = 2.6 - 1.45, fz = 4.9 - 6.05, fr = Math.atan2(fx, fz), fl = Math.hypot(fx, fz);   // turned toward the table's end
    place('chair_large_red', 1.45, 6.05, fr, 0, .54);
    place('footstool_red', 1.45 + fx/fl*.7, 6.05 + fz/fl*.7, fr, 0, .54);
    // the sideboard on the back wall (3.3..6.7, 0.12..0.6, 28 up): the ham and a wrapped gift
    for(const x of [4.15, 5.85]) place('cabinet_medium', x, .36, 0, 0, [.85, .71, .48]);
    platter(4.1, .71, .36, 'ham');
    slab(5.6, .22, 6.1, .5, .71, .92, '#C9A55A', .5); slab(5.83, .22, 5.87, .5, .71, .925, '#8A2E2A', .5);
    candelabra(3.55, .71, .36); candle(6.45, .71, .36);
    // the table: the pine runner, two candelabras, the four platters, a plate and glögg at every place
    pineRunner(T);
    candelabra(3.8, T, 3.5); candelabra(6.2, T, 3.5);
    platter(2.9, T, 3.2, 'salmon'); platter(4.5, T, 3.75, 'herring'); platter(5.7, T, 3.25, 'saffron'); platter(7.1, T, 3.75, 'salmon');
    // Elsa (b_s1) and Olle (b_s2) get milk and cookies instead of glögg, and a candy cane each
    const kid = x => pieces.plate_decorated_B && (x===4.5 || x===5.5);
    for(const x of [3.5, 4.5, 5.5, 6.5]){ plate(x, T, 2.95); glogg(x+.18, T, 2.95);
      if(kid(x)){ place('plate_decorated_B', x, 4.05, Math.PI, T, .3); place('candycane_small', x-.2, 4.12, .4, T+.348*.25*.3, .25) }
      else { plate(x, T, 4.05); glogg(x-.18, T, 4.05) } }
    plate(2.2, T, 3.5); glogg(2.25, T, 3.28); plate(7.8, T, 3.5); glogg(7.75, T, 3.72);
    spread(T);                                                                        // (enhanced) the rest of the julbord
    // clementines on the sideboard
    heap(4.62, bowl(4.62, .71, .36, .12, '#C9A55A'), .36, 8, .038, .07, '#F08A24', .9);
    for(const x of [3.8, 6.2]){ const l = new THREE.PointLight(0xffc27a, .9, 3.2, 1.8); l.position.set(x, 1.3, 3.5); room.add(l) }
    plant(.55, 5.45, .9, '#8A3B34');
  };

  // Solberg's boardroom in Oslo, after the classic 'timber' room: stone floor, board walls, a view of the
  // fjord, a table for five, the presentation screen on the left wall, the architect's model of the new
  // facility on a plinth, a stack of planks and a pallet by the window.
  ROOMS.fjord = (RS) => {
    ROOMS.board(RS);
    const TOP = KK;
    rug(1.2, 1.9, 5.6, 5.1, '#3E5A66');
    place('rectangular_dining_table_6', 3.5, 3.5, 0, 0, [2.6/2, TOP/.75, 1.56/.92]);          // 2.2..4.8 x 2.72..4.28
    chairName = 'chair_A_wood'; chairCushion = '#2E3338';
    painting(4.1, 5.9, .92, 2.25);                                                           // the print, as in Lindqvist's room
    // the presentation screen (x .08..0.14, y 2.4..4.6, 34..70 up) showing the facility plan
    { slab(.02, 2.4, .1, 4.6, .87, 1.79, '#2B2F33', .4);
      const c = document.createElement('canvas'); c.width = 704; c.height = 360; const g = c.getContext('2d'); g.scale(10, 10);
      g.fillStyle = '#2B2F33'; g.fillRect(0,0,70.4,36); g.fillStyle = '#F2F0EA'; g.fillRect(3,3,64.4,30);
      g.fillStyle = '#5E7C74'; g.fillRect(8,8,22,14); g.fillStyle = '#C9A27A'; g.fillRect(34,8,26,6); g.fillRect(34,16,18,6);
      g.fillStyle = '#2F4A5A'; g.fillRect(8,25,52,2);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, .92), new THREE.MeshBasicMaterial({map:t}));
      m.rotation.y = Math.PI/2; m.position.set(.102, 1.33, 3.5); room.add(m) }
    // the model of the new facility: plinth, landscape, halls, timber sheds (enhanced: fjord edge, road, forest)
    slab(6.0, 2.0, 8.6, 3.8, 0, .51, '#EDEBE6', .6);
    slab(6.2, 2.2, 8.4, 3.6, .51, .525, '#9DB08A', .9);
    slab(6.2, 3.42, 8.4, 3.6, .51, .528, '#7EA6BC', .3);                                     // the water's edge
    slab(6.3, 3.02, 8.3, 3.08, .525, .53, '#8A8E90', .8);                                     // a road
    slab(6.4, 2.4, 7.6, 3.0, .525, .69, '#D2D6D8', .6); slab(6.4, 2.4, 7.6, 3.0, .69, .7, '#B8BEC2', .6);
    slab(7.7, 2.4, 8.2, 3.3, .525, .84, '#B8BEC2', .6);
    slab(6.4, 3.1, 7.2, 3.4, .525, .59, '#C9A27A', .7); slab(7.3, 3.1, 7.6, 3.4, .525, .61, '#C9A27A', .7);
    for(let i=0;i<14;i++){ const x = 6.28 + (i%7)*.3 + (i>6?.14:0), z = i>6 ? 2.27 : 2.22 + (i%2)*.06;
      const t = new THREE.Mesh(new THREE.ConeGeometry(.04, .13, 6), mat(i%2?'#3F6A48':'#2E5A3A', .9)); t.position.set(x, .59, z); room.add(t) }
    // the stack of planks (8.4..9.6, 4.6..5.4) and the pallet (8.5..9.5, 5.6..6.4)
    for(let k=0;k<4;k++) for(let b=0;b<4;b++){ const z0 = 4.62 + b*.2;
      slab(8.4 + (k%2)*.05, z0, 9.6, z0 + .17, k*.13, k*.13 + .12, (k+b)%2 ? '#C99A6A' : '#B98A5A', .9) }
    for(const z of [5.62, 5.95, 6.28]) slab(8.5, z, 9.5, z + .1, 0, .07, '#A87A4E', .9);
    for(let b=0;b<6;b++) slab(8.5, 5.6 + b*.14, 9.5, 5.6 + b*.14 + .1, .07, .13, '#B8905E', .9);
    // (enhanced) two log rounds on the left wall, between the windows and the screen
    for(const z of [2.1, 4.9]){ const r = new THREE.Mesh(new THREE.CylinderGeometry(.2,.2,.05,28), mat('#D8B27A', .8));
      r.rotation.z = Math.PI/2; r.position.set(.03, 1.55, z); room.add(r);
      const bark = new THREE.Mesh(new THREE.TorusGeometry(.2,.018,6,28), mat('#5A3A24', .9)); bark.rotation.y = Math.PI/2; bark.position.set(.03, 1.55, z); room.add(bark) }
    plant(9.4, .6, 1.2, '#2E3338'); plant(.7, 5.6, 1.0, '#2E3338');
    // the table: papers, mugs; (enhanced) Jonas's laptop, rolled plans, a carafe and glasses
    const T = TOP;
    slab(2.5, 3.1, 2.9, 3.4, T, T+.012, '#FBFBF8', .9); slab(3.3, 3.05, 3.7, 3.35, T, T+.012, '#FBFBF8', .9);
    place('coffee_mug', 4.1, 3.2, 0, T, .8); place('coffee_mug', 2.7, 3.8, 0, T, .8);
    place('laptop', 4.5, 3.15, 0, T, 1);
    for(const [dz, c] of [[0, '#EEF1F3'], [.07, '#DCE6EE']]){ const r = new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,.6,12), mat(c, .8));
      r.rotation.z = Math.PI/2; r.rotation.y = .15; r.position.set(3.6, T+.03, 3.8 + dz); room.add(r) }
    const glassMat = new THREE.MeshStandardMaterial({color:'#DCEBF0', transparent:true, opacity:.5, roughness:.05, depthWrite:false});
    for(const [x, z] of [[3.3, 2.95], [4.3, 2.95], [3.7, 4.05], [4.7, 4.05], [2.45, 3.62]]){
      const g = new THREE.Mesh(new THREE.CylinderGeometry(.03,.026,.1,14), glassMat); g.position.set(x, T+.05, z); room.add(g) }
    { const g = new THREE.Mesh(new THREE.CylinderGeometry(.055,.06,.3,20), glassMat); g.position.set(3.95, T+.15, 3.5); room.add(g) }
  };

  // Sørensen Foods' headquarters in Copenhagen, after the classic 'bakery' room: white tiles and panelling,
  // the family's table for five on the right, a tasting counter with buns on the back wall, the bread rack
  // and the oven on the left wall (whose windows the 3D room leaves out: rack and oven would cover them),
  // flour sacks by the counter.
  ROOMS.copen = (RS) => {
    ROOMS.board(RS, {left:false});
    const TOP = KK;
    place('table_medium_long', 6.5, 3.5, 0, 0, [2.6/3, KK, KK]);                            // 5.2..7.8 x 2.72..4.28
    chairName = 'chair_A_wood'; chairCushion = '#2B2F33';
    painting(4.1, 5.9, .92, 2.25);
    // the tasting counter (0.9..4.7, 0.12..0.85, 24 up): white front, oak top, a plate of buns every 0.7
    slab(.9, .12, 4.7, .85, 0, .58, '#EDE8DF', .6); slab(.88, .1, 4.72, .87, .58, .62, '#C9A27A', .6);
    const domeMat = new THREE.MeshStandardMaterial({color:'#EEF4F6', transparent:true, opacity:.28, roughness:.05, depthWrite:false});
    [1.3, 2.0, 2.7, 3.4, 4.1].forEach((x, i) => { bunPlate(x, .62, .5);
      if(i%2===0){ const d = new THREE.Mesh(new THREE.SphereGeometry(.22, 20, 10, 0, 6.283, 0, 1.57), domeMat); d.position.set(x, .62, .5); room.add(d) }  // (enhanced) glass cloches
      slab(x-.06, .83, x+.06, .86, .52, .58, '#F4F1EA', .6) });                          // (enhanced) little labels on the front
    // the bread rack on the left wall (x .12..0.55, y 1.2..3.6, 62 up): four shelves of loaves
    const RK = '#8A6A48';
    slab(.12, 1.2, .2, 3.6, 0, 1.58, '#5A4030', .8); slab(.12, 1.2, .55, 1.26, 0, 1.58, RK, .8); slab(.12, 3.54, .55, 3.6, 0, 1.58, RK, .8);
    for(let r=0; r<5; r++) slab(.12, 1.26, .55, 3.54, .04 + r*.37, .07 + r*.37, RK, .8);
    for(let r=0; r<4; r++) for(let k=0; k<9; k++){ const z = 1.38 + k*.245, y = .07 + r*.37 + .07;
      const l = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .14, 4, 10), mat((k+r)%3 ? '#B9783A' : '#8A5226', .7));
      l.rotation.z = Math.PI/2; l.scale.set(1, 1, .9); l.position.set(.35, y, z); room.add(l) }
    // the oven (x .12..0.7, y 3.9..5.5, 58 up) with its glowing window
    slab(.12, 3.9, .7, 5.5, 0, 1.48, '#3A3F44', .5);
    slab(.7, 4.05, .72, 5.36, .5, 1.25, '#2B2F33', .4);
    { const c = document.createElement('canvas'); c.width = 64; c.height = 32; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0,0,0,32); gr.addColorStop(0,'#F2B24A'); gr.addColorStop(1,'#C9602E'); g.fillStyle = gr; g.fillRect(0,0,64,32);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.15, .51), new THREE.MeshBasicMaterial({map:t}));
      w.rotation.y = Math.PI/2; w.position.set(.725, .9, 4.7); room.add(w) }
    slab(.72, 4.15, .77, 5.26, .38, .45, '#C9CED2', .3);                                   // the handle
    const glow = new THREE.PointLight(0xffa050, 1.1, 3, 1.8); glow.position.set(1.1, .9, 4.7); room.add(glow);
    // flour sacks by the counter
    for(const [x, z, h, c] of [[5.1, .43, .36, '#EDE6D6'], [5.52, .46, .31, '#E6DCC8']]){
      const b = new THREE.Mesh(new THREE.CapsuleGeometry(.17, h-.2, 4, 12), mat(c, .95)); b.scale.set(1, 1, .8); b.position.set(x, h/2 + .02, z); b.castShadow = true; room.add(b) }
    plant(9.4, .6, 1.0, '#2B2F33'); plant(9.4, 5.8, .9, '#2B2F33');
    // the table: buns, mugs, papers; (enhanced) Anna's laptop with the pitch, a product box, glasses and a carafe
    const T = TOP;
    bunPlate(6.0, T, 3.5);
    place('coffee_mug', 5.6, 3.1, 0, T, .8); place('coffee_mug', 6.6, 3.1, 0, T, .8); place('coffee_mug', 7.4, 3.6, 0, T, .8);
    slab(5.4, 3.7, 5.8, 4.0, T, T+.012, '#FBFBF8', .9);
    place('laptop', 5.5, 3.15, 0, T, 1);
    slab(6.35, 3.72, 6.75, 3.98, T, T+.12, '#F2EDE2', .7); slab(6.35, 3.72, 6.75, 3.98, T+.12, T+.125, '#5E8A4E', .7);   // a plant-based product box
    const glassMat = new THREE.MeshStandardMaterial({color:'#DCEBF0', transparent:true, opacity:.5, roughness:.05, depthWrite:false});
    for(const [x, z] of [[5.3, 2.95], [6.3, 2.95], [5.7, 4.05], [6.7, 4.05], [7.55, 3.35]]){
      const g = new THREE.Mesh(new THREE.CylinderGeometry(.03,.026,.1,14), glassMat); g.position.set(x, T+.05, z); room.add(g) }
    { const g = new THREE.Mesh(new THREE.CylinderGeometry(.055,.06,.3,20), glassMat); g.position.set(7.0, T+.15, 3.5); room.add(g) }
  };

  // floor-to-ceiling glazing (the classic 'tall' windows) on a stretch of the back or left wall
  function glazing(a0, a1, wall, kind='tall'){
    const len = a1 - a0, H = 2.5, t = viewTex(kind).clone(); t.userData.keep = false; t.needsUpdate = true;
    t.wrapS = THREE.RepeatWrapping; t.repeat.set(len/1.5, 1);
    const v = new THREE.Mesh(new THREE.PlaneGeometry(len, H), new THREE.MeshBasicMaterial({map:t}));
    const frame = '#2B2F33';
    if(wall==='back'){ v.position.set((a0+a1)/2, .05 + H/2, .012); room.add(v);
      for(let x=a0; x<=a1+.001; x+=1) slab(x-.025, .01, x+.025, .06, .05, .05+H, frame, .4);
      slab(a0, .01, a1, .06, .02, .06, frame, .4); slab(a0, .01, a1, .06, .05+H, .09+H, frame, .4) }
    else { v.rotation.y = Math.PI/2; v.position.set(.012, .05 + H/2, (a0+a1)/2); room.add(v);
      for(let z=a0; z<=a1+.001; z+=1) slab(.01, z-.025, .06, z+.025, .05, .05+H, frame, .4);
      slab(.01, a0, .06, a1, .02, .06, frame, .4); slab(.01, a0, .06, a1, .05+H, .09+H, frame, .4) }
  }
  function waterBottle(x, y, z){
    const b = new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,.28,14), new THREE.MeshStandardMaterial({color:'#CFE6F2', transparent:true, opacity:.6, roughness:.1, depthWrite:false}));
    b.position.set(x, y+.14, z); room.add(b);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(.02,.02,.04,10), mat('#3F7FBF', .4)); c.position.set(x, y+.3, z); room.add(c);
  }
  // Rosenholm's boardroom: the classic 'harbour' room (the glass office at dusk, office2 furnishing):
  // tall windows on the harbour, the table for ten, the white credenza under the print, the screen.
  ROOMS.harbour = (RS) => {
    ROOMS.board(RS, {windows:false});
    glazing(0, 4, 'back'); glazing(6, 10, 'back'); glazing(0, 2.3, 'left'); glazing(4.7, 7, 'left');
    rug(1.1, 1.55, 8.9, 5.45, '#2E3B46');
    // the white table with dark legs (2.2..7.8 x 2.72..4.28)
    const TOP = KK;
    slab(2.2, 2.72, 7.8, 4.28, TOP-.04, TOP, '#EDECE8', .4);
    for(const x of [2.35, 5.0, 7.65]) for(const z of [2.85, 4.15]) slab(x-.03, z-.03, x+.03, z+.03, 0, TOP-.04, '#2B2F33', .4);
    slab(2.35, 3.47, 7.65, 3.53, .12, .16, '#2B2F33', .4);
    chairName = 'chair_A_wood'; chairCushion = '#1F2A33';
    // the white credenza (3.1..6.9, 0.18..0.55, 20 up) with a dark top; a small plant; (enhanced) a model container ship
    slab(3.1, .18, 6.9, .55, 0, .49, '#F2F1EE', .5); slab(3.08, .16, 6.92, .57, .49, .53, '#2B2F33', .4);
    plant(3.6, .36, .45, '#EDECE8');
    slab(5.6, .25, 6.3, .48, .53, .57, '#D8D2C6', .6);
    { const y = .53, x0 = 4.3, z = .36;
      slab(x0, z-.07, x0+.9, z+.07, y, y+.08, '#2E3B55', .5); slab(x0+.02, z-.065, x0+.88, z+.065, y+.08, y+.095, '#B83A32', .6);
      slab(x0+.72, z-.05, x0+.86, z+.05, y+.095, y+.2, '#F2F1EE', .5);
      const cols = ['#C9302C','#2F6B8A','#E3A83A','#3E7A4E','#8A8E90'];
      for(let i=0;i<10;i++) slab(x0+.08 + (i%5)*.12, z-.05 + Math.floor(i/5)*.05, x0+.19 + (i%5)*.12, z + Math.floor(i/5)*.05, y+.095, y+.14, cols[(i*3)%5], .6) }
    // the screen on the left wall
    slab(.02, 2.55, .08, 4.45, .92, 1.68, '#2E3338', .4); slab(.08, 2.62, .085, 4.38, .96, 1.64, '#1C2226', .15);
    plant(9.4, .6, 1.35, '#2B2F33'); plant(.6, 5.4, 1.25, '#2B2F33');
    // the table: laptops for the far row, water bottles, a coffee; (enhanced) notepads and pens
    const T = TOP;
    place('laptop', 3.5, 3.2, 0, T, 1); place('laptop', 5.5, 3.2, 0, T, 1); place('laptop', 6.5, 3.2, 0, T, 1);
    for(const [x, z] of [[2.6,3.2],[4.5,3.05],[4.5,3.95],[5.5,3.95],[6.5,3.95],[3.5,3.95]]) waterBottle(x, T, z);
    place('coffee_mug', 2.43, 3.69, 0, T, .8);
    for(const x of [3.5, 4.5, 5.5, 6.5]){ slab(x-.02, 3.72, x+.14, 3.92, T, T+.012, '#F1EDE2', .9); slab(x+.16, 3.74, x+.175, 3.9, T, T+.012, '#27313A', .4) }
    slab(4.36, 3.2, 4.62, 3.4, T, T+.012, '#F1EDE2', .9);
  };
  // Henrik's study at home, the classic 'study': dark green walls, the wall of books, a small table
  // with a candle between two wingback chairs, the reading lamp, a red rug.
  ROOMS.study = (RS) => {
    ROOMS.board(RS, {back:[1], view:'night'});
    rug(1.2, 1.9, 4.6, 5.1, (RS.rugs && RS.rugs[0] && RS.rugs[0][4]) || '#7A2E2A');
    // the small table (2.0..3.05 x 2.95..4.05)
    const TT = .64;
    slab(2.0, 2.95, 3.05, 4.05, TT-.05, TT, '#5A3A26', .5);
    for(const [x, z] of [[2.07,3.02],[2.98,3.02],[2.07,3.98],[2.98,3.98]]) slab(x-.03, z-.03, x+.03, z+.03, 0, TT-.05, '#3A2618', .6);
    candle(2.3, TT, 3.2); slab(2.55, 3.6, 2.85, 3.8, TT, TT+.012, '#F2EEE4', .9); slab(2.6, 3.25, 2.8, 3.4, TT, TT+.12, '#2E3A46', .6);
    // (enhanced) a decanter and a glass
    { const d = new THREE.Mesh(new THREE.CylinderGeometry(.05,.07,.18,16), new THREE.MeshStandardMaterial({color:'#C98A3A', transparent:true, opacity:.7, roughness:.1}));
      d.position.set(2.85, TT+.09, 3.15); room.add(d);
      const g = new THREE.Mesh(new THREE.CylinderGeometry(.03,.028,.07,12), new THREE.MeshStandardMaterial({color:'#E8D8B8', transparent:true, opacity:.6, roughness:.1})); g.position.set(2.72, TT+.035, 3.95); room.add(g) }
    // the two wingbacks at the engine's seats: b_h1 facing +x (burgundy), b_n0 facing +y (brown)
    place('chair_large_red', 1.62, 3.5, Math.PI/2, 0, .54); place('chair_large_brown', 3.5, 2.42, 0, 0, .54);
    // the wall of books (3.6..8.2, 0.08..0.42, 72 up)
    const SH = '#4A3024'; slab(3.6, .02, 8.2, .08, 0, 1.84, '#2A1A10', .9);
    slab(3.6, .02, 3.66, .42, 0, 1.84, SH, .8); slab(8.14, .02, 8.2, .42, 0, 1.84, SH, .8); slab(3.6, .02, 8.2, .42, 1.8, 1.84, SH, .8);
    const cols = ['#7A2E2A','#2F4A6A','#3E5A48','#C9A55A','#5A3A26','#8A6A48','#E8DCC4','#4A3A5A']; let sd = 11;
    const rnd = () => (sd = (sd*9301 + 49297) % 233280) / 233280;
    for(let r=0; r<4; r++){ const y0 = .04 + r*.44; slab(3.66, .08, 8.14, .42, y0, y0+.04, SH, .8);
      if(r===3) continue;
      let x = 3.7; while(x < 8.08){ const w = .045 + rnd()*.05, h = .26 + rnd()*.1;
        slab(x, .12 + rnd()*.04, Math.min(x+w, 8.1), .4, y0+.04, y0+.04+h, cols[Math.floor(rnd()*cols.length)], .8); x += w + .008 } }
    // (enhanced) on top of the shelves: a framed photo and a globe
    place('pictureframe_standing_B', 4.4, .25, 0, 1.84, KK*.55);
    { const gl = new THREE.Mesh(new THREE.SphereGeometry(.16, 20, 14), mat('#5E8AA8', .6)); gl.position.set(7.4, 2.05, .25); room.add(gl);
      slab(7.34, .19, 7.46, .31, 1.84, 1.89, '#C9A55A', .4) }
    plant(.55, 5.45, .9, '#5A3A26');
    place('lamp_standing', 1.0, 1.0, 0, 0, KK);
    const l = new THREE.PointLight(0xffd29a, 1.3, 4, 1.8); l.position.set(1.0, 1.25, 1.0); room.add(l);
    const c = new THREE.PointLight(0xffc27a, .6, 2.5, 1.8); c.position.set(2.3, 1.0, 3.2); room.add(c);
  };
  // Henrik's hospital room, the classic 'hospital': the bed under the print, a bedside table with
  // flowers, the drip stand, two armchairs at the engine's seats and a low table; evening outside.
  ROOMS.hospital = (RS) => {
    ROOMS.board(RS, {view:'night'});
    // the bed (4.2..6.4, 0.25..1.45): frame, mattress, pillow at x 4.3, pale blue blanket; (enhanced) rails and wheels
    slab(4.2, .25, 6.4, 1.45, .1, .33, '#B8C2C6', .5); slab(4.25, .3, 6.35, 1.4, .33, .46, '#FFFFFF', .7);
    slab(4.3, .35, 4.8, 1.35, .46, .54, '#F2F6F8', .8); slab(4.9, .3, 6.35, 1.4, .46, .49, '#CFE0EA', .8);
    slab(4.12, .25, 4.2, 1.45, .1, .9, '#AAB6BA', .4); slab(6.4, .25, 6.46, 1.45, .1, .62, '#AAB6BA', .4);
    slab(4.9, 1.45, 6.2, 1.48, .5, .56, '#C9D2D6', .3);
    for(const [x, z] of [[4.3,.35],[6.3,.35],[4.3,1.35],[6.3,1.35]]){ const w = new THREE.Mesh(new THREE.CylinderGeometry(.05,.05,.03,12), mat('#2B2F33'));
      w.rotation.x = Math.PI/2; w.position.set(x, .05, z); room.add(w); slab(x-.015, z-.015, x+.015, z+.015, .05, .1, '#9AA6A8', .4) }
    // the bedside table with flowers; (enhanced) a water jug and a cup
    slab(6.6, .3, 7.1, .8, 0, .51, '#E6EAEA', .6);
    bouquet(6.8, .51, .5, ['#F4F1EA','#E9C54A','#8E7CC3','#D96A5A','#F4F1EA']);
    { const j = new THREE.Mesh(new THREE.CylinderGeometry(.045,.05,.16,16), new THREE.MeshStandardMaterial({color:'#DCEBF0', transparent:true, opacity:.55, roughness:.05}));
      j.position.set(6.98, .59, .65); room.add(j) }
    // the drip stand (2.55, 2.6) with its bag; (enhanced) a monitor on a stand by the bed
    slab(2.54, 2.59, 2.58, 2.63, 0, 1.6, '#AAB2B8', .3); slab(2.45, 2.55, 2.7, 2.7, 1.58, 1.62, '#AAB2B8', .3);
    { const b = new THREE.Mesh(new THREE.CapsuleGeometry(.05, .12, 4, 8), new THREE.MeshStandardMaterial({color:'#D8ECF2', transparent:true, opacity:.7})); b.position.set(2.57, 1.45, 2.63); room.add(b) }
    slab(3.9, .5, 3.96, .56, 0, 1.2, '#AAB2B8', .3); slab(3.72, .45, 4.1, .6, 1.2, 1.46, '#2B2F33', .4);
    { const c = document.createElement('canvas'); c.width = 64; c.height = 40; const g = c.getContext('2d');
      g.fillStyle = '#0E1A14'; g.fillRect(0,0,64,40); g.strokeStyle = '#5EE08A'; g.lineWidth = 2; g.beginPath();
      [[0,24],[14,24],[18,10],[22,32],[26,24],[40,24],[44,12],[48,30],[52,24],[64,24]].forEach(([x,y],i) => i ? g.lineTo(x,y) : g.moveTo(x,y)); g.stroke();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(.34, .22), new THREE.MeshBasicMaterial({map:t})); m.position.set(3.91, 1.33, .605); room.add(m) }
    // two armchairs at the engine's seats: b_h1 facing +x, b_n0 facing +y; the low table
    // wingbacks: the Nordic lounge chair's armrests cut through a seated arm
    place('chair_large_blue', 1.62, 3.5, Math.PI/2, 0, .54); place('chair_large_blue', 3.5, 2.42, 0, 0, .54);
    slab(2.1, 3.0, 2.7, 3.6, 0, .41, '#E6EAEA', .6);
    place('coffee_mug', 2.3, 3.2, 0, .41, .8);
    plant(9.2, .8, .8, '#9AA6A8');
    const lamp = new THREE.PointLight(0xfff0d8, 1.0, 5, 1.8); lamp.position.set(5.3, 2.2, 1.2); room.add(lamp);
  };

  // Nygaard Holdings' lobby in Oslo, after the classic 'lobby': the wall of glass on the left, Next Voyage
  // (the case's own painting, props/nordic/textures/Wall_Art/next_voyage.png) on the back wall in a gilt
  // frame, the lift beside it, the sofa facing the painting, the side table with flowers, the reception desk.
  ROOMS.lobby = (RS) => {
    ROOMS.board(RS, {windows:false});
    glazing(0, 7, 'left', 'city');
    rug(3.2, 2.6, 6.8, 4.6, '#6E7A80');
    // the painting: the whole canvas at its own proportions (2.33 : 1), centred where the classic one hangs
    { const h = 2.2, w = h*1916/821, x0 = 4.9 - w/2, y0 = .32;
      slab(x0-.09, .005, x0+w+.09, .06, y0-.09, y0+h+.09, '#B8964E', .45);
      slab(x0-.03, .06, x0+w+.03, .075, y0-.03, y0+h+.03, '#8A6A2E', .5);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), images.next_voyage
        ? new THREE.MeshStandardMaterial({map:images.next_voyage, roughness:.85}) : mat('#AFC3CF', .9));
      m.position.set(4.9, y0 + h/2, .078); m.receiveShadow = true; room.add(m);
      const spot = new THREE.SpotLight(0xfff4e0, 3.2, 7, .7, .6, 1.5); spot.position.set(4.9, 2.6, 2.4);   // (enhanced) a picture light
      spot.target.position.set(4.9, 1.4, 0); room.add(spot, spot.target) }
    // the lift (8.75..9.85, 74 up): steel surround, two doors, the floor indicator
    slab(8.75, .02, 9.85, .14, 0, 1.89, '#8A9298', .35);
    slab(8.83, .14, 9.28, .15, 0, 1.53, '#C9CED2', .25); slab(9.32, .14, 9.77, .15, 0, 1.53, '#C9CED2', .25);
    slab(9.05, .14, 9.55, .15, 1.62, 1.78, '#2E3338', .3); slab(9.24, .15, 9.36, .155, 1.67, 1.72, '#F2B24A', .3);
    slab(9.9, .14, 9.96, .2, 1.0, 1.14, '#C9CED2', .3);                                      // the call button
    // the sofa facing the painting, the side table with flowers
    place('compact_sofa', 5.0, 4.45, 0, 0, [1.2, 1, 1.1]);
    slab(6.3, 3.45, 6.8, 3.95, 0, .28, '#E8E4DC', .5); bouquet(6.55, .28, 3.7, ['#F4F1EA','#E9C54A','#8E7CC3','#F4F1EA','#D96A5A']);
    // the reception desk (7.4..9.0, 5.4..6.1, 24 up) with the company's name; a laptop and a bell on it
    slab(7.4, 5.4, 9.0, 6.1, 0, .6, '#E8E4DC', .5); slab(7.36, 5.36, 9.04, 6.14, .6, .64, '#F4F2EE', .4);
    { const c = document.createElement('canvas'); c.width = 512; c.height = 64; const g = c.getContext('2d');
      g.fillStyle = '#E8E4DC'; g.fillRect(0,0,512,64); g.fillStyle = '#9A7A3A'; g.font = '600 30px Georgia, serif'; g.textAlign = 'center';
      g.fillText('N Y G A A R D   H O L D I N G S', 256, 44);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, .19), new THREE.MeshStandardMaterial({map:t, roughness:.6}));
      m.position.set(8.2, .38, 6.102); room.add(m) }
    place('laptop', 8.4, 5.8, Math.PI, .64, 1);
    { const b = new THREE.Mesh(new THREE.SphereGeometry(.045, 12, 8, 0, 6.283, 0, 1.57), mat('#C9A55A', .3)); b.position.set(7.7, .64, 5.9); room.add(b) }
    // (enhanced) Nygaard Lines' first steamship in a glass case by the window
    { const x = 1.05, z = 3.4;
      slab(x-.35, z-.2, x+.35, z+.2, 0, .8, '#2E3338', .5);
      const gl = new THREE.Mesh(new THREE.BoxGeometry(.7, .42, .4), new THREE.MeshStandardMaterial({color:'#E8F2F6', transparent:true, opacity:.22, roughness:.05, depthWrite:false}));
      gl.position.set(x, 1.01, z); room.add(gl);
      slab(x-.26, z-.05, x+.26, z+.05, .8, .88, '#2E2E30', .5); slab(x-.24, z-.045, x+.24, z+.045, .88, .9, '#8A2E2A', .6);
      slab(x-.05, z-.035, x+.08, z+.035, .9, .98, '#F2F1EE', .5);
      { const f = new THREE.Mesh(new THREE.CylinderGeometry(.022,.022,.12,10), mat('#2E2E30', .5)); f.position.set(x+.02, 1.04, z); room.add(f) }
      slab(x-.18, z-.002, x-.175, z+.002, .9, 1.16, '#5A3A26', .6); slab(x+.18, z-.002, x+.185, z+.002, .9, 1.12, '#5A3A26', .6) }
    plant(9.4, 4.6, 1.2, '#8A9298'); plant(.8, 5.4, .9, '#8A9298');
  };
  // Eriksson's boardroom on Göteborg's old harbour: the Lindqvist layout in the classic 'eriksson' style,
  // dark wood and blue-grey panelling, a dark table and chairs, the harbour through the windows.
  ROOMS.eriksson = (RS) => ROOMS.boardroom(RS, {rug:'#2F4A5A', top:'#4A3424', chair:'chair_A_wood', cushion:'#2B3A44'});
  // The Sjöström estate on Lake Mälaren, the classic 'salon': windows on the lake along the left wall only,
  // the ancestor's portrait above the dark table for nine, the sideboard with candles, the sofa by the wall.
  ROOMS.malaren = (RS) => {
    ROOMS.board(RS, {back:[], view:'lake'});
    rug(2.6, 1.9, 8.2, 5.1, '#7A3A3A');
    const TOP = KK;
    for(const x of [4.2, 6.6]) place('table_medium_long', x, 3.5, 0, 0, [KK*.8, KK, KK]);   // 3.0..7.8 x 2.72..4.28
    slab(2.98, 2.7, 7.82, 4.3, TOP-.02, TOP+.003, '#6E4A32', .35);
    chairName = 'chair_A_wood'; chairCushion = '#8FA3AE';
    // the ancestor's portrait (4.2..5.8 along the back wall, 38..90 up): a man in black on dark green, gilt frame
    { const c = document.createElement('canvas'); c.width = 512; c.height = 520; const g = c.getContext('2d'); g.scale(10, 10);
      g.fillStyle = '#B8964E'; g.fillRect(0,0,51.2,52); g.fillStyle = '#2E3A34'; g.fillRect(3,3,45.2,46);
      g.fillStyle = '#1E2226'; g.beginPath(); g.moveTo(10,49); g.quadraticCurveTo(25.6,30,41,49); g.fill();
      g.fillStyle = '#F4F0E8'; g.fillRect(23.5,33,4,8);
      g.fillStyle = '#E0BFA4'; g.beginPath(); g.ellipse(25.6,24,7,9,0,0,6.283); g.fill();
      g.fillStyle = '#CFCBC4'; g.beginPath(); g.ellipse(25.6,17,7.4,4,0,Math.PI,0); g.fill();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      slab(4.16, .005, 5.84, .07, .93, 2.33, '#B8964E', .35);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.33), new THREE.MeshStandardMaterial({map:t, roughness:.7}));
      m.position.set(5.0, 1.63, .072); room.add(m);
      const l = new THREE.SpotLight(0xfff0d8, 2.2, 5, .6, .6, 1.5); l.position.set(5.0, 2.55, 1.6); l.target.position.set(5.0, 1.6, 0); room.add(l, l.target) }
    // the sideboard (6.4..8.6, 0.12..0.6, 26 up): candles and flowers; (enhanced) a silver coffee service
    slab(6.4, .12, 8.6, .6, .06, .66, '#6E4A32', .45); slab(6.38, .1, 8.62, .62, .66, .7, '#7A5236', .4);
    for(const x of [6.95, 7.5, 8.05]) slab(x-.26, .595, x+.26, .6, .12, .6, '#5E3E28', .5);
    for(const [x, z] of [[6.4,.14],[8.6,.14],[6.4,.58],[8.6,.58]]) slab(x-.03, z-.03, x+.03, z+.03, 0, .06, '#4A3022', .5);
    candle(6.9, .7, .36); candle(8.1, .7, .36);
    bouquet(7.5, .7, .36, ['#F6F2EA','#F6F2EA','#E9DCC4','#F6F2EA','#D9C8A8']);
    { const S = mat('#C8CCD0', .25); S.metalness = .8;
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(.05,.07,.2,18), S); pot.position.set(7.95, .8, .3); room.add(pot);
      slab(7.78, .22, 8.32, .48, .7, .71, '#B8BCC0', .3);
      for(const x of [8.12, 8.22]){ const c = new THREE.Mesh(new THREE.CylinderGeometry(.03,.025,.05,12), mat('#FFFFFF', .3)); c.position.set(x, .735, .4); room.add(c) } }
    // the sofa corner: sofa facing the back wall, a low table, an armchair toward the table; (enhanced) a floor lamp
    // the sofa against the left wall between the windows, facing the room, with its low table and a floor lamp
    place('compact_sofa', .42, 3.5, -Math.PI/2, 0, [1.0, 1, 1.05]);
    slab(1.1, 3.0, 1.65, 4.0, 0, .28, '#6E4A32', .45);
    place('slim_floor_lamp', .35, 2.3, 0, 0, 1);
    { const b = new THREE.Mesh(new THREE.BoxGeometry(.3,.04,.22), mat('#7A2E2A', .7)); b.position.set(1.37, .3, 3.3); b.rotation.y = .3; room.add(b) }
    plant(9.4, .6, 1.1, '#EEF2F3'); plant(.6, .9, 1.0, '#EEF2F3');
    // the table: two candle groups, papers, flowers; (enhanced) the trust folders at Helena's end, water and glasses
    const T = TOP + .003;
    for(const x of [4.0, 6.8]){ candle(x-.1, T, 3.5); candle(x, T, 3.5); candle(x+.1, T, 3.5) }
    slab(3.4, 3.0, 3.8, 3.3, T, T+.012, '#FBFBF8', .9); slab(4.4, 3.0, 4.8, 3.3, T, T+.012, '#FBFBF8', .9);
    bouquet(5.4, T, 3.5, ['#F6F2EA','#E9C54A','#F6F2EA','#8E7CC3','#F6F2EA']);
    for(let i=0;i<3;i++) slab(7.3, 3.28 + i*.01, 7.62, 3.72 - i*.01, T + i*.02, T + i*.02 + .018, ['#2E3A46','#5A2E2A','#2E3A46'][i], .6);
    const glassMat = new THREE.MeshStandardMaterial({color:'#DCEBF0', transparent:true, opacity:.5, roughness:.05, depthWrite:false});
    for(const [x, z] of [[3.7,2.95],[4.7,2.95],[5.7,2.95],[6.7,2.95],[7.55,3.85]]){ const g = new THREE.Mesh(new THREE.CylinderGeometry(.03,.026,.1,14), glassMat); g.position.set(x, T+.05, z); room.add(g) }
    { const g = new THREE.Mesh(new THREE.CylinderGeometry(.055,.06,.3,20), glassMat); g.position.set(5.9, T+.15, 3.5); room.add(g) }
  };

  // Bixa, four rooms. Part A: the boardroom in the classic 'bixa' colours with Arthur's smithy on the wall.
  ROOMS.bixa = (RS) => ROOMS.boardroom(RS, {rug:'#5A4A3A', top:'#5A3A26', chair:'chair_A_wood', cushion:'#6E4A3A', photo:true});
  // Part B: Anders's study at night, the study in blue.
  ROOMS.anders = (RS) => ROOMS.study(RS);
  // Part C: Max and Lovisa's home, the classic 'home': two armchairs at a low table, a reading lamp, the sofa
  // and coffee table under the back windows, the dining table for four, toys on the floor.
  ROOMS.home = (RS) => {
    ROOMS.board(RS);
    rug(1.0, 1.9, 4.4, 4.9, '#C98A6A');
    place('chair_large_brown', 1.62, 3.5, Math.PI/2, 0, .54); place('chair_large_blue', 3.5, 2.42, 0, 0, .54);
    slab(2.1, 2.9, 3.0, 3.8, 0, .28, '#6E5A44', .6); slab(2.08, 2.88, 3.02, 3.82, .28, .3, '#7A6450', .5);
    place('coffee_mug', 2.4, 3.2, 0, .3, .8); place('coffee_mug', 2.7, 3.5, 0, .3, .8);
    place('lamp_standing', 1.0, 2.5, 0, 0, KK);
    const l = new THREE.PointLight(0xffe0b0, .9, 3.5, 1.8); l.position.set(1.0, 1.25, 2.5); room.add(l);
    place('compact_sofa', 6.3, 1.0, Math.PI, 0, [1.4, 1, 1.1]);
    place('pillow_A', 5.75, .75, .2, .5, KK*.55); place('pillow_B', 6.85, .75, -.2, .5, KK*.55);
    slab(5.6, 1.3, 7.0, 1.9, 0, .26, '#E8E0D0', .6);
    // the dining table (6.0..8.2 x 3.7..4.7) and its four chairs
    place('rectangular_dining_table_6', 7.1, 4.2, 0, 0, [2.2/2, KK/.75, 1/.92]);
    for(const [x, z, f] of [[6.5,3.4,0],[7.5,3.4,0],[6.5,5.0,Math.PI],[7.5,5.0,Math.PI]]) place('chair_A_wood', x, z, f);
    bouquet(7.1, KK, 4.2, ['#F4F1EA','#E9C54A','#8E7CC3','#D96A5A','#F4F1EA']);
    // toys: blocks in red, yellow and blue; (enhanced) a toy train, a teddy's ball, a drawing on the fridge wall
    slab(8.3, 5.4, 8.7, 5.8, 0, .15, '#D9534F', .6); slab(8.8, 5.5, 9.1, 5.8, 0, .1, '#F0C24A', .6); slab(8.4, 5.9, 8.7, 6.2, 0, .13, '#4A90C2', .6);
    if(pieces.train_locomotive){ place('train_locomotive', 8.95, 6.3, .6, 0, .22); place('train_wagon', 8.55, 6.55, .6, 0, .22) }
    { const b = new THREE.Mesh(new THREE.SphereGeometry(.09, 16, 12), mat('#E36A7A', .5)); b.position.set(8.0, .09, 5.9); room.add(b) }
    { const c = document.createElement('canvas'); c.width = 96; c.height = 72; const g = c.getContext('2d');
      g.fillStyle = '#FFFFFF'; g.fillRect(0,0,96,72); g.fillStyle = '#F0C24A'; g.beginPath(); g.arc(76,16,10,0,6.283); g.fill();
      g.fillStyle = '#5E9A4A'; g.fillRect(0,56,96,16); g.fillStyle = '#D9534F'; g.fillRect(20,32,30,24); g.fillStyle = '#4A90C2';
      g.beginPath(); g.moveTo(16,32); g.lineTo(35,14); g.lineTo(54,32); g.closePath(); g.fill();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(.4, .3), new THREE.MeshStandardMaterial({map:t, roughness:.9})); m.position.set(8.4, 1.5, .02); room.add(m) }
    painting(4.1, 5.9, .92, 2.25);
    plant(9.4, .6, 1.1, '#E9E4DA'); plant(.6, .8, .9, '#E9E4DA');
  };
  // Part D: Karin's therapy room, the classic 'therapy': two armchairs with a small table, water and tissues,
  // a low bookcase on the back wall with two small frames above, a reading lamp, a desk with papers.
  ROOMS.therapy = (RS) => {
    ROOMS.board(RS);
    rug(1.0, 1.9, 4.4, 4.9, '#8A9A7A');
    place('chair_large_green', 1.62, 3.5, Math.PI/2, 0, .54); place('chair_large_brown', 3.5, 2.42, 0, 0, .54);
    slab(2.2, 2.5, 2.7, 3.0, 0, .36, '#6E5A44', .6);
    slab(2.3, 2.6, 2.55, 2.8, .36, .44, '#FFFFFF', .7); slab(2.38, 2.66, 2.47, 2.74, .44, .51, '#F4F4F4', .8);        // tissues
    { const g = new THREE.Mesh(new THREE.CylinderGeometry(.035,.03,.12,14), new THREE.MeshStandardMaterial({color:'#D8ECF2', transparent:true, opacity:.6, roughness:.1}));
      g.position.set(2.62, .42, 2.9); room.add(g) }
    // the bookcase (5.0..7.8, 0.08..0.42, 62 up), three shelves, gaps between the books
    const SH = '#8A6A48'; slab(5.0, .02, 7.8, .08, 0, 1.58, '#5A4030', .9);
    slab(5.0, .02, 5.06, .42, 0, 1.58, SH, .8); slab(7.74, .02, 7.8, .42, 0, 1.58, SH, .8); slab(5.0, .02, 7.8, .42, 1.54, 1.58, SH, .8);
    const cols = ['#7A8A6A','#B9785A','#E8DCC4','#4A5A6A','#C9A55A']; let sd = 23;
    const rnd = () => (sd = (sd*9301 + 49297) % 233280) / 233280;
    for(let r=0; r<3; r++){ const y0 = .04 + r*.51; slab(5.06, .08, 7.74, .42, y0, y0+.04, SH, .8);
      let x = 5.1; while(x < 7.68){ if(rnd() < .18){ x += .25; continue } const w = .05 + rnd()*.06, h = .23 + rnd()*.13;
        slab(x, .12 + rnd()*.04, Math.min(x+w, 7.7), .4, y0+.04, y0+.04+h, cols[Math.floor(rnd()*cols.length)], .8); x += w + .012 } }
    place('pillow_B', 6.3, .25, 0, 1.58 + .1*KK*.4, KK*.4);                                     // (enhanced) a folded blanket on top
    for(const x0 of [3.2, 3.9]){ slab(x0, .02, x0+.5, .08, 1.33, 1.68, '#B8964E', .5);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(.42, .27), mat(x0 < 3.5 ? '#9DB09A' : '#C4927A', .9)); m.position.set(x0+.25, 1.505, .082); room.add(m) }
    place('lamp_standing', 1.0, 2.4, 0, 0, KK);
    const l = new THREE.PointLight(0xffe4b8, .9, 3.5, 1.8); l.position.set(1.0, 1.25, 2.4); room.add(l);
    // the desk (8.2..9.4, 2.4..3.2, 24 up) with papers; (enhanced) a clock facing the therapist's chair
    slab(8.2, 2.4, 9.4, 3.2, .58, .62, '#C99A6A', .5);
    for(const [x, z] of [[8.25,2.45],[9.35,2.45],[8.25,3.15],[9.35,3.15]]) slab(x-.025, z-.025, x+.025, z+.025, 0, .58, '#8A6A48', .6);
    slab(8.4, 2.6, 8.9, 2.9, .62, .632, '#FBFBF8', .9);
    wallClock(.02, 5.2, 1.7, .16);
    plant(.7, .8, 1.2, '#B8AA92'); plant(9.3, 5.6, 1.0, '#B8AA92');
  };
  ROOMS.board_items = (SP, CF) => {
    // a chair at every boardroom seat the engine defines, turned the way the engine turns it.
    // A seat's facing lives in CHAIRFACE: the engine lays the chairs out after it creates the seats.
    for(const s of Object.values(SP)){
      if(!s.id || !/^b_/.test(s.id) || !CF[s.px+'|'+s.py]) continue;   // only where the classic room has a chair
      const f = FACE[s.face] || FACE[CF[s.px+'|'+s.py]] || [0,1];
      place(chairName, s.px, s.py, Math.atan2(f[0], f[1]));
      if(chairCushion) cushion(s.px, s.py, Math.atan2(f[0], f[1]), chairCushion);
    }
  };

  let CF = {}, chairName = 'chair_A', chairCushion = null, nearWalls = null;
  function buildRoom(RS, SP, chairFace){
    CF = chairFace || {};
    dispose(room, false); room.clear(); clockHands = null; nearWalls = null; tickers.length = 0; chairName = 'chair_A'; chairCushion = null;
    mood(RS.light);
    (ROOMS[RS.key] || ROOMS[layout] || ROOMS.boardroom)(RS); ROOMS.board_items(SP, CF);   // by the classic room's style, else the case's
  }

  // ------------------------------------------------ people
  function faces(root){ const o=[]; root.traverse(n=>{ if(n.isMesh && n.morphTargetDictionary) o.push(n) }); return o }
  function setFace(a, name, w){ const p = PRESET[name]||{};
    for(const n of a.ms){ const t = /Mouth/.test(n.name) ? p.m : p.u;
      if(t && n.morphTargetDictionary[t]!==undefined) n.morphTargetInfluences[n.morphTargetDictionary[t]] = w } }
  function castPeople(people){
    cast.clear(); actors = {};
    for(const p of people){
      const g = personas[p.cid]; if(!g) continue;            // no persona (a child): the engine draws nothing in 3D
      const ch = p.child ? CHILD : 1;                        // children: smaller, feet off the floor when seated
      const root = g.scene; root.scale.setScalar(KK*ch);
      const mats = [];
      root.traverse(n=>{ if(n.isMesh){ n.castShadow = true; n.receiveShadow = true;
        for(const m of [].concat(n.material)) if(!mats.includes(m)) mats.push(m) } });
      cast.add(root);
      const mx = new THREE.AnimationMixer(root); mx.timeScale = .85;
      const own = {}; g.animations.forEach(c => own[c.name] = c);
      const base = own.Sit_Chair_Idle ? mx.clipAction(own.Sit_Chair_Idle) : null;
      if(base){ base.play(); base.setEffectiveWeight(1) }
      let head = null, hands = []; root.traverse(n=>{ if(n.isBone && n.name==='head') head = n; if(n.isBone && /^hand\.?[lr]$/.test(n.name)) hands.push(n) });
      const ms = faces(root);
      const a = {p, root, mats, fade:1, ch, hands, mx, own, base, baseW:1, baseWant:1, head, ms,
        mouthMeshes: ms.filter(n=>/Mouth/.test(n.name)), eyes: ms.filter(n=>/Eye/.test(n.name)),
        cur:null, clipKey:'', expr:'Neutral', exprFrom:'Neutral', exprT:1, yaw:0, mouth:0,
        lastX:p.x, lastY:p.y, heading:0, react:null};
      actors[p.id] = a;
    }
  }
  function play(a, key, clip, w, once){
    if(a.clipKey===key || !clip) return;
    const next = a.mx.clipAction(clip);
    next.reset(); next.setLoop(once?THREE.LoopOnce:THREE.LoopRepeat, Infinity); next.clampWhenFinished = !!once;
    next.play(); next.setEffectiveWeight(w); next.fadeIn(.3);
    if(a.cur && a.cur!==next) a.cur.fadeOut(.3);
    a.cur = next; a.clipKey = key;
    a.baseWant = w>=1 ? 0 : 1;             // a full-weight clip (a hand, a walk) stands alone
  }
  function showExpr(a, name){ if(!PRESET[name] || a.expr===name) return;
    setFace(a, a.exprFrom, 0); a.exprFrom = a.expr; a.expr = name; a.exprT = 0 }

  // ------------------------------------------------ cameras
  let portrait = null;        // {actor, az, el, dist, t}
  const shotNow = {az:Math.PI/4, el:EL, dist:40, t:new THREE.Vector3(5,.9,3.5), fov:8};
  const shotWant = {az:Math.PI/4, el:EL, dist:40, t:new THREE.Vector3(5,.9,3.5), fov:8};
  let persActive = false, returning = false;

  function syncOrtho(cam, vw, vh){
    const z = cam.zoom * K;
    ortho.left = -cam.px / z; ortho.right = (vw - cam.px) / z;
    ortho.top = cam.py / z;   ortho.bottom = (cam.py - vh) / z;
    ortho.position.copy(DIR).multiplyScalar(60);
    ortho.lookAt(0,0,0); ortho.updateProjectionMatrix(); ortho.updateMatrixWorld();
  }
  // the pose a long lens from far away needs to show what the ortho camera shows
  function wideEquivalent(cam, vw, vh){
    const z = cam.zoom * K;
    const r = (vw/2 - cam.px)/z, u = (cam.py - vh/2)/z;
    const right = new THREE.Vector3(1,0,-1).normalize();
    const up = new THREE.Vector3().crossVectors(DIR.clone().negate(), right).negate().normalize();
    const c = right.multiplyScalar(r).add(up.multiplyScalar(u));
    // slide along the view axis to the floor-ish plane, so the target sits in the room
    const tgt = c.clone().add(DIR.clone().multiplyScalar((0.9 - c.y) / DIR.y));
    const D = 40, h = vh / z;
    return {az:Math.PI/4, el:EL, dist:D, t:tgt, fov: 2*Math.atan(h/2/D)*180/Math.PI};
  }
  let shotArgs = null, handAimT = 0;
  function shot(sp, to, cam, vw, vh){
    shotArgs = [sp, to, cam, vw, vh];
    const a = sp && actors[sp.id];
    if(!a){                                 // back to the room: ease out, then hand over to ortho
      if(persActive){ Object.assign(shotWant, wideEquivalent(cam, vw, vh)); returning = true }
      portrait = null; return;
    }
    if(!persActive){ Object.assign(shotNow, wideEquivalent(cam, vw, vh)); shotNow.t = shotNow.t.clone(); persActive = true }
    returning = false;
    // aim at the middle of the head (the bone sits at the neck) and stand back for the shoulders:
    // the controls take the top fifth of the stage and the caption the bottom strip
    const hp = new THREE.Vector3(); a.head.getWorldPosition(hp); hp.y += p_up(sp);
    // face the face: the head turns (up to 0.7) toward whoever is addressed or looked at, so the lens follows
    // most of that turn, or the shot is a profile
    let az = a.heading;
    const b = to && actors[to.id], g = sp.gaze;
    const look = b ? (() => { const bp = new THREE.Vector3(); b.head.getWorldPosition(bp); return [bp.x, bp.z] })()
               : g ? (g.p ? [g.p.x, g.p.y] : g.w) : null;
    if(look){ let d = Math.atan2(look[0]-hp.x, look[1]-hp.z) - a.heading;
      while(d>Math.PI) d-=2*Math.PI; while(d<-Math.PI) d+=2*Math.PI; az += Math.max(-.7, Math.min(.7, d)) * .8 }
    else az += .12;
    portrait = a; a._aimHand = a.clipKey.startsWith('hand');
    // The lens has to stand inside the room. Facing a wall (Ingrid at the painting), swing round the speaker
    // to the nearest angle that fits: a three-quarter view or a profile. If none does, come closer and widen
    // the lens so the frame stays the same.
    // First choice, a face-on shot across the table: stay within a small angle of the speaker's front and
    // come closer with a slightly wider lens until the camera fits in the room. Only when there is no room
    // for that (someone facing a wall) swing round to a three-quarter view or a profile.
    const D = p_dist(sp), F = 16.06;
    let dist = D;
    const inside = (az, d) => { const ch = Math.cos(.14)*d, x = hp.x + Math.sin(az)*ch, z = hp.z + Math.cos(az)*ch;
      return x > .15 && x < 9.85 && z > .15 && z < 6.85 };
    const reach = az => { let d = D; while(d > 2.6 && !inside(az, d)) d -= .05; return inside(az, d) ? d : 0 };
    if(!inside(az, D)){
      let best = null;
      for(const off of [0, .15, -.15, .3, -.3]){ const d = reach(az + off); if(d && (!best || d > best.d + .2)) best = {az: az + off, d} }
      if(best){ az = best.az; dist = best.d }
      else { let found = null;
        for(let k=1; k<=12 && found===null; k++) for(const sgn of [1, -1]){ const c = az + sgn*k*.15; if(inside(c, D)){ found = c; break } }
        if(found!==null) az = found;
        else { while(dist > 1.2 && !inside(az, dist)) dist -= .1 } }
    }
    let fov = 2*Math.atan(Math.tan(F*Math.PI/360)*D/dist)*180/Math.PI;            // same frame from nearer
    // A raised hand: frame from the shoulders to above the hand, and swing away from the raised arm so the
    // hand, which comes up in front of the body, stands clear of the face.
    const up = a.clipKey.startsWith('hand') && a.hands.length ? a.hands.map(h => h.getWorldPosition(new THREE.Vector3())).sort((u, v) => v.y - u.y)[0] : null;
    if(up){
      const hb = new THREE.Vector3(); a.head.getWorldPosition(hb);
      const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));                // the frame's right, seen from the lens
      const side = Math.sign(up.clone().sub(hb).dot(right)) || 1;
      for(const sw of [.55, .4, .25]){ const az2 = az - side*sw; if(inside(az2, dist)){ az = az2; break } }   // away from the arm: the hand clears the face
      const top = Math.max(up.y, hb.y + .5) + .2, bottom = hb.y - .45, need = (top - bottom) / .78;   // shoulders to above the hand; the controls take the top fifth
      hp.set((hb.x + up.x)/2, (top + bottom)/2 + need*.08, (hb.z + up.z)/2);
      fov = Math.max(fov, 2*Math.atan(need/2/dist)*180/Math.PI);
    }
    Object.assign(shotWant, {az, el:.14, dist, t:hp, fov});
    return !!up;
  }
  // a raised hand needs room above the head; everything else is head and shoulders
  // (measured once settled: the head runs from the bone to ~0.75 above it, the controls cover the top fifth)
  const p_dist = sp => sp && sp.gesture==='hand' ? 6.4 : 5.4;
  const p_up = sp => sp && sp.gesture==='hand' ? .7 : .45;
  function easePersp(dt, vw, vh){
    const j = 1 - Math.exp(-dt*2.2);
    let d = shotWant.az - shotNow.az; while(d>Math.PI) d-=2*Math.PI; while(d<-Math.PI) d+=2*Math.PI;
    shotNow.az += d*j; shotNow.el += (shotWant.el-shotNow.el)*j;
    shotNow.dist += (shotWant.dist-shotNow.dist)*j; shotNow.fov += (shotWant.fov-shotNow.fov)*j;
    shotNow.t.lerp(shotWant.t, j);
    // never behind the solid back or left wall: where the arc would cross one, come in closer along the
    // same line and widen the lens to keep the frame (a portrait only; the arc in from the room starts outside)
    let dist = shotNow.dist, fov = shotNow.fov;
    const at = d => { const ch = Math.cos(shotNow.el)*d;
      return [shotNow.t.x + Math.sin(shotNow.az)*ch, shotNow.t.y + Math.sin(shotNow.el)*d, shotNow.t.z + Math.cos(shotNow.az)*ch] };
    if(!returning && shotWant.dist < 12 && dist < 12){
      let p = at(dist);
      while(dist > .8 && (p[0] < .15 || p[2] < .15)){ dist -= .05; p = at(dist) }
      if(dist < shotNow.dist) fov = 2*Math.atan(Math.tan(fov*Math.PI/360)*shotNow.dist/dist)*180/Math.PI;
    }
    persp.position.set(...at(dist));
    persp.lookAt(shotNow.t); persp.fov = fov; persp.aspect = vw/vh; persp.updateProjectionMatrix();
    persp.updateMatrixWorld();
    if(returning && Math.abs(shotNow.dist-shotWant.dist) < 1.5 && shotNow.t.distanceTo(shotWant.t) < .08){
      persActive = false; returning = false }
  }
  // The room is open on its near sides: anyone past its edges (the doorway, a corridor spot) fades
  // out over half a tile instead of walking on air. The engine skips their name tag (p.out3D).
  function fadeAt(a){
    const p = a.p, out = Math.max(0, -p.x, p.x-10, -p.y, p.y-7);
    const f = Math.max(0, Math.min(1, 1 - out/.5));
    p.out3D = f < .5;
    if(f===a.fade) return; a.fade = f;
    for(const m of a.mats){ m.transparent = f < 1; m.opacity = f; m.depthWrite = f >= 1; m.needsUpdate = true }
  }
  // a portrait looks across the table, so whoever sits on the line of sight steps out of frame
  function clearShot(){
    for(const id in actors){ const a = actors[id];
      fadeAt(a); a.root.visible = a.p.visible && !a.p.hidden && a.fade > .01 }
    if(!persActive || !portrait) return;
    const s = new THREE.Vector3(); portrait.head.getWorldPosition(s);
    const c = persp.position, dir = s.clone().sub(c), len = dir.length(); dir.normalize();
    for(const id in actors){ const a = actors[id]; if(a===portrait || !a.root.visible) continue;
      const p = new THREE.Vector3(); a.head.getWorldPosition(p);
      const t = p.clone().sub(c).dot(dir), off = p.distanceTo(c.clone().add(dir.clone().multiplyScalar(t)));
      if((t>.3 && t<len-.25 && off<.75) || (t>.3 && t<len-1 && off<1.15) || p.distanceTo(c) < 1.1) a.root.visible = false }   // on the line, well in front, or at the lens
  }

  // ------------------------------------------------ per frame
  const tmp = new THREE.Vector3();
  function frame(st){
    const {people, cam, vw, vh, dpr, dt, animT, level} = st;
    for(const f of tickers) f(animT);
    if(clockHands && st.clock!=null){ const m = st.clock % 720;
      clockHands.h.rotation.z = -m/720*2*Math.PI; clockHands.m.rotation.z = -(m%60)/60*2*Math.PI }
    renderer.setPixelRatio(dpr); renderer.setSize(vw, vh, false);
    syncOrtho(cam, vw, vh);
    if(persActive) easePersp(Math.min(dt,.4), vw, vh);
    const camera = persActive ? persp : ortho;
    // a hand that goes up during a close-up: re-aim once the pose has settled
    if(persActive && portrait && !returning && shotArgs){ const h = portrait.clipKey.startsWith('hand');
      if(h !== !!portrait._aimHand){ handAimT += dt; if(handAimT > .5){ handAimT = 0; portrait._aimHand = h; shot(...shotArgs) } } else handAimT = 0 }
    if(nearWalls){ const c = persp.position;
      nearWalls.visible = persActive && c.x > .05 && c.x < 9.9 && c.z > .05 && c.z < 6.9 }
    const dtA = Math.min(dt, .05);

    for(const p of people){
      const a = actors[p.id]; if(!a) continue;
      a.p = p;
      // --- where and which way
      let fx, fz;
      if(p.seated && p.spot){
        // the seat's facing, else the chair's, else (as the 2D figures do) toward what they look at
        let f = FACE[p.spot.face] || FACE[(st.chairFace||CF)[p.spot.px+'|'+p.spot.py]];
        if(!f && p.gaze){ const t = p.gaze.p ? [p.gaze.p.x, p.gaze.p.y] : p.gaze.w; f = [t[0]-p.x, t[1]-p.y] }
        f = f || [0,1]; fx = f[0]; fz = f[1];
        a.root.position.set(p.x + fx*SIT_FWD*a.ch, SEAT_Y*(1-a.ch), p.y + fz*SIT_FWD*a.ch);
      } else {
        const dx = p.x - a.lastX, dy = p.y - a.lastY;
        if(p.moving && Math.hypot(dx,dy) > 1e-4){ fx = dx; fz = dy }
        else if(p.gaze){ const t = p.gaze.p ? [p.gaze.p.x, p.gaze.p.y] : p.gaze.w; fx = t[0]-p.x; fz = t[1]-p.y }
        else { fx = p.fx ?? 0; fz = p.fy ?? 1 }
        a.root.position.set(p.x, 0, p.y);
      }
      a.lastX = p.x; a.lastY = p.y;
      if(Math.hypot(fx,fz) > 1e-4){ const h = Math.atan2(fx, fz);
        let d = h - a.heading; while(d>Math.PI) d-=2*Math.PI; while(d<-Math.PI) d+=2*Math.PI;
        a.heading += d * Math.min(1, dt*(p.seated?30:8)) }
      a.root.rotation.y = a.heading;
      // --- body
      const S = p.seated;
      if(p.moving) play(a, 'walk', a.own.Walking_A, 1);
      else if(p.gesture==='hand') play(a, 'hand'+S, S ? clips.HandRaise_Seated_Idle : clips.HandRaise_Idle, 1);
      else if(p.react==='nod' && a.react!=='nod') play(a, 'nod'+animT, S ? clips.Nod_Yes_Seated : clips.Nod_Yes, MOTION*1.6, true);
      else if(p.talking) play(a, 'talk'+S, S ? (p.id%2 ? clips.Talking_Seated_B : clips.Talking_Seated) : clips.Talking_A, MOTION);
      else if(!(a.clipKey.startsWith('nod') && a.cur && a.cur.isRunning()))
        play(a, 'idle'+S, S ? clips.Listening : a.own.Idle_A, S ? MOTION : 1);
      a.react = p.react;
      a.mx.update(dtA);
      if(a.base){ a.baseW += (a.baseWant - a.baseW)*Math.min(1, dtA*8); a.base.setEffectiveWeight(S ? a.baseW : 0) }
      // --- face: an emote beats a thought beats the mood
      let want = MOOD[p.mood] || 'Neutral';
      if(p.thought) want = 'Thinking';
      if(p.emote && p.emote.until > animT && EMOTE[p.emote.t]) want = EMOTE[p.emote.t];
      showExpr(a, want);
      if(a.exprT < 1){ a.exprT = Math.min(1, a.exprT + dtA*2.6);
        setFace(a, a.exprFrom, .8*(1-a.exprT)); setFace(a, a.expr, .8*a.exprT) }
      const blink = animT < (p.blinkUntil||0) ? 1 : 0;
      for(const n of a.eyes){ const i = n.morphTargetDictionary.Blink; if(i!==undefined) n.morphTargetInfluences[i] = blink }
      // --- mouth follows the recording
      const target = (p.talking && !p.moving) ? (level ?? .4) : 0;
      a.mouth += (target - a.mouth) * Math.min(1, dtA*18);
      for(const n of a.mouthMeshes){ const o = n.morphTargetDictionary.SpeakingOpen, s2 = n.morphTargetDictionary.SpeakingSmall;
        if(o!==undefined) n.morphTargetInfluences[o] = a.mouth*.85; if(s2!==undefined) n.morphTargetInfluences[s2] = a.mouth*.35 }
      // --- the head turns toward what the engine says this person is looking at
      if(a.head){
        let yaw = 0;
        if(p.gaze && !p.moving){ const t = p.gaze.p ? [p.gaze.p.x, p.gaze.p.y] : p.gaze.w;
          a.head.getWorldPosition(tmp);
          let d = Math.atan2(t[0]-tmp.x, t[1]-tmp.z) - a.heading;
          while(d>Math.PI) d-=2*Math.PI; while(d<-Math.PI) d+=2*Math.PI; yaw = Math.max(-.7, Math.min(.7, d)) }
        a.yaw += (yaw - a.yaw) * Math.min(1, dtA*3.5);
        if(Math.abs(a.yaw) > .004){ const pq = new THREE.Quaternion(); a.head.parent.getWorldQuaternion(pq);
          const axis = new THREE.Vector3(0,1,0).applyQuaternion(pq.invert()).normalize();
          a.head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, a.yaw)) }
      }
    }
    clearShot();
    renderer.render(scene, camera);

    // --- hand the engine its head and hit positions, in its own world pixels, for the overlays
    const toW = v => { v.project(camera); const sx = (v.x+1)/2*vw, sy = (1-v.y)/2*vh;
      return [(sx - cam.px)/cam.zoom, (sy - cam.py)/cam.zoom] };
    for(const p of people){
      const a = actors[p.id]; if(!a || !a.head) continue;
      a.head.getWorldPosition(tmp); tmp.y += .62;
      const top = toW(tmp.clone());
      const foot = toW(a.root.position.clone());
      const w = Math.abs(top[1]-foot[1]) * .32;
      p.headW = top; p.hitW = [top[0]-w, top[1], top[0]+w, foot[1]];
    }
  }

  return {
    canvas, get ready(){ return ready }, get portrait(){ return persActive },
    has: id => lastCase===id && ready && !lost,
    loadCase,
    build(RS, SP, people, chairFace){ buildRoom(RS, SP, chairFace); castPeople(people) },
    cast: castPeople,
    shot, frame,
    show(on){ canvas.style.display = on ? 'block' : 'none' },
  };
}
