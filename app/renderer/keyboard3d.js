import * as THREE from '../../node_modules/three/build/three.module.js';
import { EffectComposer } from '../../node_modules/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../../node_modules/three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from '../../node_modules/three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from '../../node_modules/three/examples/jsm/postprocessing/OutputPass.js';
import { HDRLoader } from '../../node_modules/three/examples/jsm/loaders/HDRLoader.js';
import { toCreasedNormals } from '../../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAYOUT, LAYOUT_WIDTH, LAYOUT_HEIGHT } from './layout.js';

// Geometry and color blocking follow Wobkey's Silver Reboot Pro product photo:
// white double-shot PBT, black Esc / Enter / space, silver top-frame islands,
// and the small heartbeat indicator above the arrows. This is a procedural
// visual approximation; no part of this module communicates with the hardware.
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const CAP = { ivory: '#eef0ee', accent: '#292d30', dark: '#252a2e' };

function outline(w, d, r, Path = THREE.Shape) {
  const p = new Path(), x = -w / 2, z = -d / 2;
  return p.moveTo(x + r,z).lineTo(x + w - r,z)
    .quadraticCurveTo(x + w,z,x + w,z + r).lineTo(x + w,z + d - r)
    .quadraticCurveTo(x + w,z + d,x + w - r,z + d).lineTo(x + r,z + d)
    .quadraticCurveTo(x,z + d,x,z + d - r).lineTo(x,z + r)
    .quadraticCurveTo(x,z,x + r,z);
}

function extrude(shape, h, bevel = .025) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * bevel, steps: 1, bevelEnabled: bevel > 0,
    bevelSegments: 4, bevelSize: bevel, bevelThickness: bevel, curveSegments: 12,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -h / 2 + bevel, 0);
  // ExtrudeGeometry leaves each bevel segment disconnected. Weld its shading
  // normals across the curved chamfer, while retaining the flat machined faces.
  return machinedNormals(g);
}
function machinedNormals(g) {
  // The helper hashes at 0.01 world units; these sub-millimetre bevels need
  // finer precision, otherwise adjacent bevel rings collapse into one normal.
  g.scale(100,100,100);
  const smooth=toCreasedNormals(g,Math.PI*.42);
  smooth.scale(.01,.01,.01);
  return smooth;
}
function block(w,h,d,r=.08,bevel=.02) {
  return extrude(outline(w - 2 * bevel,d - 2 * bevel,r), h, bevel);
}

// A smooth continuous perimeter, sampled in the same order for every ring.
// The previous mesh used coarse corner fans: their normals visibly pinched.
function perimeter(w,d,r,segments=10,edgeSegments=12) {
  const out = [];
  for (let corner=0;corner<4;corner++) {
    const cx=(corner===0||corner===3 ? 1:-1)*(w/2-r);
    const cz=(corner<2 ? 1:-1)*(d/2-r);
    for(let j=0;j<segments;j++) {
      const a=corner*Math.PI/2+j/segments*Math.PI/2;
      out.push([cx+Math.cos(a)*r,cz+Math.sin(a)*r]);
    }
    const end=(corner+1)*Math.PI/2;
    const nextCorner=(corner+1)%4;
    const nextX=(nextCorner===0||nextCorner===3?1:-1)*(w/2-r)+Math.cos(end)*r;
    const nextZ=(nextCorner<2?1:-1)*(d/2-r)+Math.sin(end)*r;
    const endX=cx+Math.cos(end)*r,endZ=cz+Math.sin(end)*r;
    for(let j=0;j<edgeSegments;j++)out.push([THREE.MathUtils.lerp(endX,nextX,j/edgeSegments),THREE.MathUtils.lerp(endZ,nextZ,j/edgeSegments)]);
  }
  return out;
}

function capGeometry(width, height, tilt, space=false) {
  const positions=[],uvs=[],indices=[];
  const tw=width-.30,td=.66,n=88;
  const rings = [
    [width-.075,.925,.008,.045],
    [width-.055,.935,.035,.052],
    [width-.065,.925,.075,.052],
    [tw+.065,td+.065,height-.045,.065],
    [tw+.030,td+.030,height-.015,.075],
    [tw,td,height,.082],
  ];
  // Smoothly curved top, with a cylindrical dish running front to back.
  // A convex spacebar is appropriate for Cherry-style bottom-row caps.
  for(let step=1;step<=12;step++) {
    const scale=1-step/13;
    rings.push([tw*scale,td*scale,height,.082*scale]);
  }
  rings.forEach(([w,d,y,r],ring)=>{
    perimeter(w,d,Math.min(r,d*.48,w*.48)).forEach(([x,z])=>{
      let topY=y + tilt*z;
      if(ring>=5) {
        const nz=z/(td/2);
        topY += space ? .035*(1-nz*nz) : -.080*(1-nz*nz);
      }
      positions.push(x,topY,z);
      uvs.push(x/tw+.5,.5-z/td);
    });
  });
  for(let ring=0;ring<rings.length-1;ring++) {
    for(let i=0;i<n;i++) {
      const a=ring*n+i,b=ring*n+(i+1)%n;
      indices.push(a,a+n,b,b,a+n,b+n);
    }
  }
  const center=positions.length/3;
  positions.push(0,height+(space?.035:-.080),0);uvs.push(.5,.5);
  const last=(rings.length-1)*n;
  for(let i=0;i<n;i++)indices.push(last+i,center,last+(i+1)%n);
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  g.setIndex(indices);
  const skirtCount=5*n*6;
  g.addGroup(0,skirtCount,0);
  g.addGroup(skirtCount,indices.length-skirtCount,1);
  g.computeVertexNormals();
  // The top is an analytic cylindrical surface. Averaging the very long
  // perimeter triangles creates diagonal pinching on large black keycaps.
  const normals=g.attributes.normal;
  const along=new THREE.Vector3(),up=new THREE.Vector3(),normal=new THREE.Vector3();
  for(let ring=0;ring<5;ring++)for(let i=0;i<n;i++) {
    const before=(ring*n+(i+n-1)%n)*3,after=(ring*n+(i+1)%n)*3;
    const below=(Math.max(0,ring-1)*n+i)*3,above=((ring+1)*n+i)*3;
    along.set(positions[after]-positions[before],positions[after+1]-positions[before+1],positions[after+2]-positions[before+2]);
    up.set(positions[above]-positions[below],positions[above+1]-positions[below+1],positions[above+2]-positions[below+2]);
    normal.crossVectors(up,along).normalize();
    normals.setXYZ(ring*n+i,normal.x,normal.y,normal.z);
  }
  for(let i=5*n;i<positions.length/3;i++) {
    const z=positions[i*3+2],slope=tilt+(space?-.070:.160)*z/((td/2)*(td/2));
    const ny=1/Math.sqrt(1+slope*slope);
    normals.setXYZ(i,0,ny,-slope*ny);
  }
  return g;
}

function noiseTexture(brushed=false) {
  const c=document.createElement('canvas');c.width=c.height=128;
  const ctx=c.getContext('2d'),data=ctx.createImageData(128,128);
  let seed=919;
  let line=0;
  for(let i=0;i<data.data.length;i+=4) {
    seed=(seed*1664525+1013904223)>>>0;
    if(i%(128*4)===0)line=seed%7;
    const v=brushed?128+line+(seed%3):125+(seed%15);
    data.data.set([v,v,v,255],i);
  }
  ctx.putImageData(data,0,0);
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(brushed?1:2,brushed?4:2);t.anisotropy=8;
  return t;
}
function legendTexture(key,color,dark=false) {
  const c=document.createElement('canvas');c.width=Math.ceil(256*key.w);c.height=256;
  const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,c.width,c.height);
  x.fillStyle=dark?'#eff0ec':'#11171a';x.textBaseline='top';
  const aliases={Backspace:'← Backspace',Caps:'Caps Lock',Enter:'↵ Enter',Shift:'⇧ Shift',Print:'Print',Scroll:'Scroll',Pause:'Pause',Insert:'Insert',Delete:'Delete',PgUp:'PgUp',PgDn:'PgDn',Super:'Super',Win:'Win',Left:'←',Right:'→',Up:'↑',Down:'↓',Space:''};
  const shifted={'`':'~','1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')','-':'_','=':'+','[':'{',']':'}','\\':'|',';':':',"'":'"',',':'<','.':'>','/':'?'};
  const label=aliases[key.name]??key.name;
  const left=key.w===1?24:28;
  if(shifted[key.name]) {
    x.font='500 69px Arial, sans-serif';x.fillText(shifted[key.name],left,9);
    x.font='600 73px Arial, sans-serif';x.fillText(key.name,left,102);
  } else if(key.name==='Tab') {
    x.font='500 46px Arial, sans-serif';x.fillText('⇤',left,9);x.fillText('Tab',left,59);x.fillText('⇥',left,107);
  } else {
    const alpha=/^[A-Z]$/.test(label),arrow=['Up','Down','Left','Right'].includes(key.name);
    const size=alpha?112:arrow?104:label.length>4&&key.w===1?52:56;
    x.font='600 '+size+'px Arial, sans-serif';
    x.fillText(label,left,alpha?9:17);
  }
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;
  return t;
}
function radialTexture() {
  const c=document.createElement('canvas');c.width=c.height=128;
  const x=c.getContext('2d'),g=x.createRadialGradient(64,64,0,64,64,64);
  g.addColorStop(0,'#ffffff');g.addColorStop(.15,'#ffffffb0');g.addColorStop(.48,'#ffffff38');g.addColorStop(1,'#ffffff00');
  x.fillStyle=g;x.fillRect(0,0,128,128);return new THREE.CanvasTexture(c);
}
function makeEnvironment(renderer) {
  // Immediate HDR studio fallback while the bundled panorama is decoded.
  // Values above 1 are intentional: real softboxes must be much brighter than
  // the room, otherwise a metal surface becomes a uniform gray painted object.
  const s=new THREE.Scene();s.background=new THREE.Color().setRGB(.14,.145,.15);
  const walls=new THREE.Mesh(new THREE.BoxGeometry(40,24,32),new THREE.MeshBasicMaterial({color:new THREE.Color().setRGB(.18,.185,.19),side:THREE.BackSide}));
  s.add(walls);
  function panel(w,h,pos,intensity) {
    const color=new THREE.Color().setRGB(intensity,intensity,intensity);
    const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide}));
    m.position.set(...pos);m.lookAt(0,0,0);s.add(m);
  }
  panel(17,8,[-5,11,-6],5.5);
  panel(13,4,[8,6,13],3.2);
  panel(3,15,[-16,2,1],7);
  panel(10,8,[0,-11,2],2);
  const p=new THREE.PMREMGenerator(renderer),rt=p.fromScene(s,.025);
  s.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});p.dispose();return rt;
}

export function createKeyboardPreview(container,{onSelect}={}) {
  if(!container)throw new Error('Keyboard preview requires a container.');
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.10;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.VSMShadowMap;
  renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
  renderer.setClearColor('#000000',0);
  const canvas=renderer.domElement;
  canvas.style.cssText='display:block;width:100%;height:100%;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;-webkit-app-region:no-drag;pointer-events:auto';
  canvas.draggable=false;
  canvas.tabIndex=0;canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label','Interactive silver Crush 80 keyboard. Drag or use arrow keys to rotate; scroll or use plus and minus to zoom; Home resets.');
  container.append(canvas);
  const scene=new THREE.Scene();
  // A long lens gives the almost parallel product-photo perspective of the
  // real board, avoiding the exaggerated triangular shape of the first model.
  const camera=new THREE.PerspectiveCamera(24,1,.1,200);
  let environment=makeEnvironment(renderer);scene.environment=environment.texture;scene.environmentIntensity=.65;
  scene.environmentRotation.y=.65;
  const board=new THREE.Group();board.rotation.x=.075;scene.add(board);
  const geometries=new Set(),materials=new Set(),textures=new Set();
  const trackGeometry=g=>(geometries.add(g),g);
  const material=p=>{const m=new THREE.MeshStandardMaterial(p);materials.add(m);return m;};
  const mesh=(g,m,x=0,y=0,z=0)=>{
    const o=new THREE.Mesh(trackGeometry(g),m);o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;board.add(o);return o;
  };
  const grain=noiseTexture();textures.add(grain);
  const brushing=noiseTexture(true);textures.add(brushing);
  // Satin anodized aluminum: broad, directionally brushed reflections rather
  // than sharp softbox/window shapes. The microscopic grain stays subpixel.
  const metal=new THREE.MeshPhysicalMaterial({color:'#d5d7d9',metalness:.92,roughness:.47,anisotropy:.32,envMap:environment.texture,envMapIntensity:.92,bumpMap:brushing,bumpScale:.00025});materials.add(metal);
  metal.envMapRotation.y=.65;
  const seam=material({color:'#343b40',metalness:.35,roughness:.55});
  const caseSeam=material({color:'#62696d',metalness:.65,roughness:.42});
  const rubber=material({color:'#111518',roughness:.95});
  const plateMaterial=material({color:'#333c40',roughness:.86});
  const bw=19.15,bd=7.12;
  let baseGeometry=block(bw-.06,.61,bd-.04,.11,.04);
  const basePositions=baseGeometry.attributes.position;
  for(let i=0;i<basePositions.count;i++) {
    const y=basePositions.getY(i),z=basePositions.getZ(i);
    basePositions.setY(i,y+z*.075*clamp(-y/.305,0,1));
  }
  baseGeometry=machinedNormals(baseGeometry);
  mesh(baseGeometry,metal,0,-.30,0);
  mesh(block(bw-.02,.025,bd-.015,.11,.004),caseSeam,0,.012,0);
  // One solid machined frame, with actual large openings for each key cluster.
  const frameShape=outline(bw-.06,bd-.06,.11);
  function opening(x,y,w,d,r=.06) {
    const p=outline(w,d,r,THREE.Path);
    const dx=x+w/2-LAYOUT_WIDTH/2,dz=-(y+d/2-LAYOUT_HEIGHT/2);
    p.curves.forEach(curve=>{
      for(const property of ['v0','v1','v2','v3'])if(curve[property]){curve[property].x+=dx;curve[property].y+=dz;}
    });
    frameShape.holes.push(p);
  }
  opening(-.035,1.215,15.07,5.07,.08);
  opening(-.035,-.035,1.07,1.07);
  opening(1.215,-.035,4.07,1.07);opening(5.465,-.035,4.07,1.07);opening(9.715,-.035,4.07,1.07);
  opening(13.965,-.035,1.07,1.07);opening(15.215,-.035,3.07,1.07);
  opening(15.215,1.215,3.07,2.07);
  // Inverted-T arrow cluster is a single opening, with aluminum shoulders.
  const arrow=new THREE.Path();
  const verts=[[15.215,5.215],[16.215,5.215],[16.215,4.215],[17.285,4.215],[17.285,5.215],[18.285,5.215],[18.285,6.285],[15.215,6.285]];
  verts.forEach(([x,y],i)=>i?arrow.lineTo(x-LAYOUT_WIDTH/2,-(y-LAYOUT_HEIGHT/2)):arrow.moveTo(x-LAYOUT_WIDTH/2,-(y-LAYOUT_HEIGHT/2)));
  arrow.closePath();frameShape.holes.push(arrow);
  mesh(extrude(frameShape,.32,.022),metal,0,.19,0);
  mesh(block(LAYOUT_WIDTH+.12,.06,LAYOUT_HEIGHT+.12,.08,.015),plateMaterial,0,.12,0);
  const footMaterial=material({color:'#b8bdbd',roughness:.94});
  for(const x of [-8.05,8.05])for(const z of [-2.15,2.94])mesh(block(1.80,.08,.24,.08,.015),footMaterial,x,-.65+z*.075,z);
  // Rear port is centred on the production case.
  const port=mesh(block(.50,.16,.035,.055,.008),rubber,0,-.13,-bd/2-.012);port.castShadow=false;
  const inside=mesh(block(.28,.055,.04,.02,.005),seam,0,-.13,-bd/2-.030);inside.castShadow=false;

  const glowMap=radialTexture();textures.add(glowMap);
  // The silver production board has a separate, flat underside: a dark
  // textured weight, a small magnetic receiver cover, and short RGB windows
  // at the rear ends of the two side rails. It has no full-length light strip.
  const underside=new THREE.Group();underside.position.y=-.614;underside.rotation.x=-.075;board.add(underside);
  const undersideMesh=(g,m,x=0,y=0,z=0)=>{const o=mesh(g,m,x,y,z);underside.add(o);return o;};
  undersideMesh(block(18.37,.035,4.15,.16,.008),seam,0,-.006,-.48);
  const weightCanvas=document.createElement('canvas');weightCanvas.width=1024;weightCanvas.height=256;
  const wc=weightCanvas.getContext('2d');wc.fillStyle='#333739';wc.fillRect(0,0,1024,256);
  let weightSeed=8301;
  const weightRandom=()=>{weightSeed=(weightSeed*1664525+1013904223)>>>0;return weightSeed/4294967296;};
  for(let i=0;i<22000;i++){
    const x=weightRandom()*1024,y=weightRandom()*256,v=Math.floor(90+weightRandom()*130);
    wc.fillStyle=`rgba(${v},${v},${v},${.08+weightRandom()*.4})`;
    wc.fillRect(x,y,.6+weightRandom()*2.2,.4+weightRandom()*1.2);
  }
  const weightMap=new THREE.CanvasTexture(weightCanvas);weightMap.colorSpace=THREE.SRGBColorSpace;weightMap.anisotropy=8;textures.add(weightMap);
  const weightMaterial=material({map:weightMap,metalness:.46,roughness:.40,envMap:environment.texture,envMapIntensity:.9,bumpMap:weightMap,bumpScale:.008});
  const weightGeometry=block(18.12,.035,3.91,.11,.008);
  for(let i=0;i<weightGeometry.attributes.position.count;i++){
    weightGeometry.attributes.uv.setXY(i,weightGeometry.attributes.position.getX(i)/18.12+.5,weightGeometry.attributes.position.getZ(i)/3.91+.5);
  }
  undersideMesh(weightGeometry,weightMaterial,0,-.027,-.48);
  undersideMesh(block(1.63,.04,1.85,.10,.01),rubber,0,-.055,-.42);
  undersideMesh(block(1.46,.05,1.68,.08,.012),metal,0,-.080,-.42);
  const receiverCanvas=document.createElement('canvas');receiverCanvas.width=256;receiverCanvas.height=160;
  const rc=receiverCanvas.getContext('2d');rc.fillStyle='#62686c';rc.textAlign='center';rc.textBaseline='middle';rc.font='700 76px Arial, sans-serif';rc.fillText('wob',128,80);
  const receiverMap=new THREE.CanvasTexture(receiverCanvas);receiverMap.colorSpace=THREE.SRGBColorSpace;textures.add(receiverMap);
  const receiverInk=new THREE.MeshBasicMaterial({map:receiverMap,transparent:true,depthWrite:false});materials.add(receiverInk);
  const receiverMark=undersideMesh(new THREE.PlaneGeometry(1.04,.65),receiverInk,0,-.107,-.42);receiverMark.rotation.x=Math.PI/2;receiverMark.castShadow=false;
  const lowerLights=[],groundGlows=[];
  for(const side of [-1,1]){
    const slotX=side*(bw/2-.235),slotZ=-1.78;
    undersideMesh(block(.17,.028,1.40,.045,.006),seam,slotX,-.018,slotZ);
    for(let segment=0;segment<6;segment++){
      const z=slotZ+(segment-2.5)*.211;
      const diffuser=material({color:'#e2e5e3',roughness:.38,emissive:'#ff8000',emissiveIntensity:1.2});
      undersideMesh(block(.095,.035,.216,.012,.004),diffuser,slotX,-.043,z).castShadow=false;
      // This return around the bottom corner makes the short window visible
      // from a normal seated viewing angle as well as from underneath.
      const edge=mesh(block(.026,.105,.216,.009,.003),diffuser,side*(bw/2-.028),-.52+z*.075,z);edge.castShadow=false;
      lowerLights.push({material:diffuser,position:segment/6});
    }
    const spillMaterial=new THREE.MeshBasicMaterial({map:glowMap,color:'#ff8000',transparent:true,opacity:.15,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});materials.add(spillMaterial);
    const spill=new THREE.Mesh(trackGeometry(new THREE.PlaneGeometry(2.6,2.35)),spillMaterial);
    spill.rotation.x=-Math.PI/2;spill.position.set(side*(bw/2-.05),-.704,slotZ);scene.add(spill);
    groundGlows.push({mesh:spill,material:spillMaterial,position:side<0?.20:.70});
  }
  const keyMeshes=[],keyData=[],glows=[],ledColors=[];
  const capCache=new Map(),occlusionGeometry=new THREE.PlaneGeometry(1,1);
  geometries.add(occlusionGeometry);
  const shadowMat=new THREE.MeshBasicMaterial({map:glowMap,color:'#000000',transparent:true,opacity:.75,depthWrite:false});materials.add(shadowMat);
  const keyColor=key=>['Esc','Enter','Space'].includes(key.name)?CAP.accent:CAP.ivory;
  LAYOUT.forEach((key,i)=>{
    const x=key.x+key.w/2-LAYOUT_WIDTH/2,z=key.y+.5-LAYOUT_HEIGHT/2;
    const row=key.y===0?0:Math.round(key.y-.25);
    const height=[.61,.61,.55,.51,.54,.54][row]??.54;
    const tilt=[-.09,-.09,-.035,.025,.10,.085][row]??.03;
    const color=keyColor(key),isBlack=color===CAP.accent;
    const texture=legendTexture(key,color,isBlack);textures.add(texture);
    // Top-planar UVs collapse on the steep skirt. A bump map there stretched
    // individual noise texels into visible vertical ribs, unlike molded PBT.
    const side=material({color,roughness:.61});
    const top=new THREE.MeshPhysicalMaterial({map:texture,roughness:.56,specularIntensity:.44,bumpMap:grain,bumpScale:.0018});materials.add(top);
    const gkey=key.w+':'+height+':'+tilt;
    if(!capCache.has(gkey))capCache.set(gkey,trackGeometry(capGeometry(key.w,height,tilt,key.name==='Space')));
    const cap=new THREE.Mesh(capCache.get(gkey),[side,top]);
    cap.position.set(x,.205,z);cap.castShadow=true;cap.receiveShadow=true;cap.userData.keyIndex=i;board.add(cap);keyMeshes.push(cap);
    keyData.push({key,cap,side,top,color});
    const ao=new THREE.Mesh(occlusionGeometry,shadowMat);ao.rotation.x=-Math.PI/2;
    ao.scale.set(key.w+.20,1.16,1);ao.position.set(x,.165,z);board.add(ao);
    // South-facing LED: a small source under the skirt, not a glowing key outline.
    const led=material({color:'#121719',emissive:'#ff8000',emissiveIntensity:.8,roughness:.8});
    const source=mesh(block(.15,.025,.10,.025,.006),led,x,.18,z+.435);source.castShadow=false;
    const glowMaterial=new THREE.MeshBasicMaterial({map:glowMap,color:'#ff8000',transparent:true,opacity:.24,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});
    materials.add(glowMaterial);
    const halo=new THREE.Mesh(trackGeometry(new THREE.PlaneGeometry(Math.min(key.w+.15,1.65),1.18)),glowMaterial);
    halo.rotation.x=-Math.PI/2;halo.position.set(x,.179,z+.24);board.add(halo);
    glows.push(glowMaterial);ledColors.push(led);
    if(key.name==='F'||key.name==='J')mesh(block(.17,.018,.035,.012,.005),side,x,.205+height-.012+tilt*.24,z+.24);
  });

  const badge=document.createElement('canvas');badge.width=512;badge.height=160;
  const bc=badge.getContext('2d');bc.strokeStyle='#d4faff';bc.fillStyle='#d4faff';bc.lineWidth=15;bc.lineJoin='round';bc.lineCap='round';
  bc.beginPath();bc.moveTo(80,80);bc.lineTo(175,80);bc.lineTo(205,28);bc.lineTo(245,130);bc.lineTo(290,60);bc.lineTo(330,80);bc.lineTo(425,80);bc.stroke();
  for(const x of [40,470]){bc.beginPath();bc.arc(x,80,8,0,TAU);bc.fill();}
  const badgeMap=new THREE.CanvasTexture(badge);badgeMap.colorSpace=THREE.SRGBColorSpace;textures.add(badgeMap);
  const badgeMat=new THREE.MeshBasicMaterial({map:badgeMap,color:'#4fcce0',transparent:true,depthWrite:false,toneMapped:false});materials.add(badgeMat);
  const emblem=mesh(new THREE.PlaneGeometry(.80,.25),badgeMat,7.75,.358,.61);emblem.rotation.x=-Math.PI/2;emblem.castShadow=false;

  const ambient=new THREE.HemisphereLight('#f8f7f4','#b9b4ac',.20);scene.add(ambient);
  const keyLight=new THREE.DirectionalLight('#fffaf4',.95);keyLight.position.set(-7,15,-3);keyLight.castShadow=true;
  keyLight.shadow.mapSize.set(1024,1024);Object.assign(keyLight.shadow.camera,{left:-13,right:13,top:11,bottom:-11,near:.5,far:45});
  keyLight.shadow.bias=-.00015;keyLight.shadow.normalBias=.035;keyLight.shadow.radius=9;keyLight.shadow.blurSamples=12;scene.add(keyLight);
  const rim=new THREE.DirectionalLight('#e7eef5',.28);rim.position.set(3,8,-9);scene.add(rim);
  const fill=new THREE.DirectionalLight('#fffaf4',.22);fill.position.set(10,4,6);scene.add(fill);
  const undersideLight=new THREE.DirectionalLight('#eef2f5',0);undersideLight.position.set(-4,-9,5);scene.add(undersideLight);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(60,40),new THREE.ShadowMaterial({opacity:.19}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-.71;floor.receiveShadow=true;scene.add(floor);
  geometries.add(floor.geometry);materials.add(floor.material);
  const renderTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, renderTarget);
  const beautyPass = new RenderPass(scene, camera);
  const occlusionPass = new SSAOPass(scene, camera, 1, 1, 32);
  occlusionPass.kernelRadius = .65;
  occlusionPass.minDistance = .0001;
  occlusionPass.maxDistance = .009;
  // Transparent LED spill/contact cards do not represent solid geometry.
  // Exclude them from the depth/normal pass to avoid false rectangular AO.
  const renderOcclusion=occlusionPass.render.bind(occlusionPass);
  occlusionPass.render=(...args)=>{
    const hidden=[];
    scene.traverse(o=>{if(o.visible&&o.isMesh&&!Array.isArray(o.material)&&o.material.transparent){hidden.push(o);o.visible=false;}});
    try{return renderOcclusion(...args);}finally{hidden.forEach(o=>{o.visible=true;});}
  };
  const outputPass = new OutputPass();
  composer.addPass(beautyPass);
  composer.addPass(occlusionPass);
  composer.addPass(outputPass);
  // Soft contact occlusion stays directly under the rubber feet. The case's
  // lower wedge and foot heights compensate for deck tilt; all feet land at
  // y ~= -.69, just above this ground plane.
  const footprint=document.createElement('canvas');footprint.width=512;footprint.height=256;
  const fc=footprint.getContext('2d');fc.filter='blur(13px)';fc.fillStyle='#000000';
  fc.beginPath();fc.roundRect(29,29,454,198,12);fc.fill();
  const footprintMap=new THREE.CanvasTexture(footprint);textures.add(footprintMap);
  const contact=new THREE.Mesh(new THREE.PlaneGeometry(bw+.7,bd+.7),new THREE.MeshBasicMaterial({map:footprintMap,transparent:true,opacity:.23,depthWrite:false}));
  contact.rotation.x=-Math.PI/2;contact.position.y=-.707;scene.add(contact);
  geometries.add(contact.geometry);materials.add(contact.material);


  let disposed = false, visible = true, frame = 0, lastFrame = 0, invalid = true;
  let lighting = { effect: 6, hueDeg: 30, sat: 255, brightness: 7, speed: 2, rainbowLocked: false };
  let keyColors = {};
  let selectedKey = -1;
  // The caller supplies confirmed live colors only for physically mapped keys.
  // Stock rear state cannot be read, so it defaults to the observed rainbow.
  let rearLighting={mode:'rainbow',brightness:.8,speed:.055,hueDeg:210,sat:255};
  let theme='light';
  let yaw = -.105, polar = .72, zoom = 1, view = 'perspective';
  let targetYaw = yaw, targetPolar = polar, targetZoom = zoom;
  let pointer = null, dragDistance = 0, hover = -1;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hsv = new THREE.Color();
  const pointerVector = new THREE.Vector2(), raycaster = new THREE.Raycaster();
  const target = new THREE.Vector3(0, .05, 0);
  // Fit the physical model, not a fixed wide camera frustum. Reprojecting these
  // bounds also keeps the case inside the viewport while orbiting underneath.
  board.updateMatrixWorld(true);
  const fitCorners=[];
  board.traverse(o=>{
    if(!o.isMesh||(!Array.isArray(o.material)&&o.material.transparent))return;
    o.geometry.computeBoundingBox();const bounds=o.geometry.boundingBox;
    for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])fitCorners.push(new THREE.Vector3(x,y,z).applyMatrix4(o.matrixWorld).sub(target));
  });
  const eyeDirection=new THREE.Vector3(),cameraRight=new THREE.Vector3(),cameraUp=new THREE.Vector3(),worldUp=new THREE.Vector3(0,1,0);

  function updateCamera() {
    // Fit the complete chassis at narrow inspector layouts as well as wide views.
    const aspect = Math.max(.2, container.clientWidth / Math.max(1, container.clientHeight));
    camera.aspect = aspect;
    eyeDirection.set(Math.sin(yaw)*Math.sin(polar),Math.cos(polar),Math.cos(yaw)*Math.sin(polar));
    cameraRight.crossVectors(worldUp,eyeDirection).normalize();cameraUp.crossVectors(eyeDirection,cameraRight).normalize();
    const tanHalfFov=Math.tan(THREE.MathUtils.degToRad(camera.fov)/2);
    let fitDistance=1;
    for(const corner of fitCorners){
      const depth=corner.dot(eyeDirection);
      fitDistance=Math.max(fitDistance,Math.abs(corner.dot(cameraRight))/(tanHalfFov*aspect*.91)+depth,Math.abs(corner.dot(cameraUp))/(tanHalfFov*.90)+depth);
    }
    camera.position.copy(eyeDirection).multiplyScalar(fitDistance*zoom).add(target);
    camera.lookAt(target); camera.updateProjectionMatrix();
    occlusionPass.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
    occlusionPass.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
    const aboveGround=camera.position.y>-.5;
    floor.visible=contact.visible=aboveGround;
    groundGlows.forEach(({mesh})=>{mesh.visible=aboveGround;});
    undersideLight.intensity=clamp(-Math.cos(polar)*(theme==='dark'?.65:1.15),0,1.15);
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (w > 0 && h > 0) {
      renderer.setSize(w, h, false);
      updateCamera();
      composer.setSize(w, h);
      // Resizing clears the WebGL drawing buffer. Paint immediately even when
      // the containing Electron window is occluded; a future animation frame
      // is not guaranteed until the OS exposes the window again.
      paint(performance.now() / 1000);
      composer.render();
      invalid = true;
      wake();
    }
  }
  const observer = new ResizeObserver(resize); observer.observe(container);

  function strength(i, t) {
    const key = LAYOUT[i], phase = t * (.6 + lighting.speed * .38);
    switch (lighting.effect) {
      case 0: return 0;
      case 6: return 1;
      case 5: return .2 + .8 * (.5 + .5 * Math.sin(phase * 2));
      case 1: case 9: case 12: case 13: case 16: return .16 + .84 * Math.pow(.5 + .5 * Math.sin(key.x * .62 - phase * 2), 3);
      case 3: case 11: case 18: return .13 + .87 * Math.pow(.5 + .5 * Math.sin(Math.hypot(key.x - 9, key.y - 3) * .9 - phase * 2), 3);
      case 2: case 4: return .22 + .78 * (.5 + .5 * Math.sin(key.x * .4 + key.y * .8 - phase));
      default: return .10 + .90 * Math.pow(.5 + .5 * Math.sin(i * 4.791 + phase * 2), 10);
    }
  }

  function paint(t) {
    const brightness = lighting.brightness / 9;
    for (let i = 0; i < ledColors.length; i++) {
      const hue = lighting.rainbowLocked ? ((LAYOUT[i].x / LAYOUT_WIDTH) + t * .04) % 1 : lighting.hueDeg / 360;
      // UI colors are sRGB HSV with value 1. Convert explicitly into Three's
      // linear working space; treating orange's .5 green channel as linear
      // made the preview look yellow, especially around the warm end.
      hsv.setHSL(hue, 1, 1 - lighting.sat / 510, THREE.SRGBColorSpace);
      if (keyColors[i] && lighting.effect === 6) hsv.setRGB(...keyColors[i].map(v => v / 255), THREE.SRGBColorSpace);
      const a = brightness * strength(i, reduced.matches ? 1.5 : t);
      const led = ledColors[i]; led.emissive.copy(hsv); led.emissiveIntensity = a * 1.8;
      glows[i].color.copy(hsv); glows[i].opacity = a * (theme==='dark'?.84:.48);
      keyData[i].side.emissive.copy(hsv); keyData[i].side.emissiveIntensity = a * (theme==='dark'?.020:.008);
    }
    for(const lower of lowerLights){
      const hue=rearLighting.mode==='rainbow'?(lower.position+(reduced.matches?0:t)*rearLighting.speed)%1:rearLighting.hueDeg/360;
      hsv.setHSL(hue,1,rearLighting.mode==='rainbow'?.5:1-rearLighting.sat/510,THREE.SRGBColorSpace);
      const a=rearLighting.mode==='off'?0:rearLighting.brightness;
      lower.material.emissive.copy(hsv);lower.material.emissiveIntensity=a*2.2;
      lower.material.color.set('#c5cbcb').lerp(hsv,a*.55);
    }
    for(const glow of groundGlows){
      const hue=rearLighting.mode==='rainbow'?(glow.position+(reduced.matches?0:t)*rearLighting.speed)%1:rearLighting.hueDeg/360;
      hsv.setHSL(hue,1,rearLighting.mode==='rainbow'?.5:1-rearLighting.sat/510,THREE.SRGBColorSpace);
      const a=rearLighting.mode==='off'?0:rearLighting.brightness;
      glow.material.color.copy(hsv);glow.material.opacity=a*(theme==='dark'?.38:.23);
    }
  }

  function render(now) {
    if (disposed || !visible || document.hidden) { frame = 0; return; }
    frame = requestAnimationFrame(render);
    if (now - lastFrame < 1000 / 30) return;
    lastFrame = now;
    const changing = Math.abs(yaw - targetYaw) + Math.abs(polar - targetPolar) + Math.abs(zoom - targetZoom) > .0003;
    if (changing) {
      const lerp = reduced.matches ? 1 : .18;
      yaw += (targetYaw - yaw) * lerp; polar += (targetPolar - polar) * lerp; zoom += (targetZoom - zoom) * lerp;
      updateCamera();
    }
    const animated = !reduced.matches && ((lighting.brightness > 0 && (lighting.rainbowLocked || (lighting.effect !== 0 && lighting.effect !== 6))) || (rearLighting.mode==='rainbow'&&rearLighting.brightness>0));
    if (!invalid && !changing && !animated) return;
    paint(now / 1000); composer.render(); invalid = false;
  }
  function wake() { invalid = true; if (!frame && visible && !document.hidden && !disposed) frame = requestAnimationFrame(render); }
  function visibility() { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else wake(); }
  document.addEventListener('visibilitychange', visibility);
  reduced.addEventListener('change', wake);

  function pick(e) {
    if(camera.position.y<0)return -1;
    const r = canvas.getBoundingClientRect();
    pointerVector.set((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2);
    raycaster.setFromCamera(pointerVector, camera);
    return raycaster.intersectObjects(keyMeshes, false)[0]?.object.userData.keyIndex ?? -1;
  }
  function announceView(next){
    container.dispatchEvent(new CustomEvent('preview-view-change',{detail:{view:next}}));
  }
  function onDown(e) {
    if (pointer || (e.pointerType==='mouse'&&e.button!==0)) return;
    e.preventDefault();canvas.focus({preventScroll:true});
    // Pointer focus can inherit Chromium's keyboard-focus heuristic after a
    // dialog. Keep the focus ring for Tab navigation, not mouse orbiting.
    canvas.style.outline='none';
    pointer = { id:e.pointerId,x:e.clientX,y:e.clientY,announced:false }; dragDistance = 0;
    try{canvas.setPointerCapture(e.pointerId);}catch{/* Global pointer handlers still complete the drag. */}
    canvas.style.cursor = 'grabbing';
  }
  function onMove(e) {
    if (pointer) {
      if(e.pointerId!==pointer.id)return;
      e.preventDefault();
      const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
      dragDistance += Math.abs(dx) + Math.abs(dy);
      targetYaw -= dx * .006;
      targetPolar = clamp(targetPolar + dy * .006, .035, Math.PI-.035); view = 'perspective';
      pointer.x=e.clientX;pointer.y=e.clientY;
      if(dragDistance>4&&!pointer.announced){pointer.announced=true;announceView('custom');}
      wake();
    } else if(e.target===canvas) {
      const next = pick(e);
      if (next !== hover) { hover = next; canvas.title = onSelect && next >= 0 ? `${LAYOUT[next].name} · drag to rotate` : 'Drag to rotate · scroll to zoom'; }
    }
  }
  function onUp(e) {
    if (!pointer || e.pointerId!==pointer.id) return;
    pointer = null; canvas.style.cursor = 'grab';
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (dragDistance < 5 && onSelect) { const i = pick(e); if (i >= 0) onSelect(i); }
  }
  function onCancel() { const id=pointer?.id;pointer=null;canvas.style.cursor='grab';if(id!==undefined&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id); }
  function onWheel(e) { e.preventDefault(); targetZoom = clamp(targetZoom + e.deltaY * .0007, .72, 1.55); wake(); }
  function onKey(e) {
    if (e.key === 'ArrowLeft') targetYaw -= .12;
    else if (e.key === 'ArrowRight') targetYaw += .12;
    else if (e.key === 'ArrowUp') targetPolar = clamp(targetPolar - .10, .035, Math.PI-.035);
    else if (e.key === 'ArrowDown') targetPolar = clamp(targetPolar + .10, .035, Math.PI-.035);
    else if (e.key === '+' || e.key === '=') targetZoom = clamp(targetZoom - .1, .72, 1.55);
    else if (e.key === '-') targetZoom = clamp(targetZoom + .1, .72, 1.55);
    else if (e.key === 'Home') { targetYaw = -.105; targetPolar = .72; targetZoom = 1; }
    else return;
    e.preventDefault();
    if(e.key.startsWith('Arrow')){view='perspective';announceView('custom');}
    else if(e.key==='Home'){view='perspective';announceView('perspective');}
    wake();
  }
  function onFocus() {
    if (canvas.matches(':focus-visible')) {
      canvas.style.outline = '2px solid #f89554';
      canvas.style.outlineOffset = '-3px';
    }
  }
  function onBlur() { canvas.style.outline = ''; canvas.style.outlineOffset = ''; }
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, {capture:true,passive:false});
  window.addEventListener('pointerup', onUp, true);window.addEventListener('pointercancel', onCancel, true);
  canvas.addEventListener('lostpointercapture',onCancel);window.addEventListener('blur',onCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('focus', onFocus); canvas.addEventListener('blur', onBlur);
  const contextLost = (e) => { e.preventDefault(); container.dispatchEvent(new CustomEvent('preview-error', { detail: 'The 3D graphics context was interrupted.' })); };
  canvas.addEventListener('webglcontextlost', contextLost);
  resize(); wake();
  new HDRLoader().load(new URL('./assets/model/studio_small_08_1k.hdr',import.meta.url).href,panorama=>{
    if(disposed){panorama.dispose();return;}
    const pmrem=new THREE.PMREMGenerator(renderer),next=pmrem.fromEquirectangular(panorama);
    panorama.dispose();pmrem.dispose();
    const previous=environment;environment=next;scene.environment=next.texture;
    materials.forEach(m=>{if(m.envMap===previous.texture){m.envMap=next.texture;m.needsUpdate=true;}});
    previous.dispose();wake();
  },undefined,()=>{ /* The local HDR studio remains usable if an asset is missing. */ });

  return {
    canvas,
    setLighting(next) { lighting = { ...lighting, ...next }; wake(); },
    setKeyColors(next) { keyColors = Object.fromEntries(Object.entries(next).map(([i, rgb]) => [i, [...rgb]])); wake(); },
    setSelectedKey(index) {
      if (index === selectedKey) return;
      selectedKey = index;
      keyData.forEach(({ top }, i) => {
        top.color.set(i === index ? '#a5d4df' : '#ffffff');
        top.emissive.set(i === index ? '#4cbbd5' : '#000000');
        top.emissiveIntensity = i === index ? .11 : 0;
      });
      wake();
    },
    // Preview state supplied by the app; this module never writes hardware.
    setRearLighting(next){rearLighting={...rearLighting,...next};rearLighting.brightness=clamp(rearLighting.brightness,0,1);wake();},
    setTheme(next){
      theme=next==='dark'?'dark':'light';const dark=theme==='dark';
      scene.environmentIntensity=dark?.32:.65;metal.envMapIntensity=dark?.60:.92;
      ambient.intensity=dark?.10:.20;keyLight.intensity=dark?.48:.95;rim.intensity=dark?.26:.28;fill.intensity=dark?.12:.22;
      renderer.toneMappingExposure=dark?1.03:1.10;
      floor.material.opacity=dark?.28:.19;contact.material.opacity=dark?.30:.23;
      updateCamera();wake();
    },
    setVisible(next) { visible = !!next; if (visible) { resize(); wake(); } else { cancelAnimationFrame(frame); frame = 0; } },
    setView(next) {
      view = next === 'top' || next === 'bottom' ? next : 'perspective';
      targetYaw = view === 'top' ? 0 : -.105;
      targetPolar = view === 'top' ? .035 : view === 'bottom' ? Math.PI-.36 : .72;
      targetZoom = 1; wake();
    },
    reset() { view = 'perspective'; targetYaw = -.105; targetPolar = .72; targetZoom = 1; wake(); },
    setFinish(finish) {
      const dark = finish === 'dark'; metal.color.set(dark ? '#3d434a' : '#d5d7d9');
      keyData.forEach(({ key, side, top, color }) => {
        const c = dark ? CAP.dark : color;
        side.color.set(c); textures.delete(top.map); top.map.dispose(); top.map = legendTexture(key, c, dark || color === CAP.accent); textures.add(top.map); top.needsUpdate = true;
      }); wake();
    },
    dispose() {
      if (disposed) return; disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', wake);
      onCancel();canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove',onMove,true);window.removeEventListener('pointerup',onUp,true);window.removeEventListener('pointercancel',onCancel,true);
      canvas.removeEventListener('lostpointercapture',onCancel);window.removeEventListener('blur',onCancel);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('focus', onFocus); canvas.removeEventListener('blur', onBlur);
      geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose());
      beautyPass.dispose(); occlusionPass.dispose(); outputPass.dispose(); composer.dispose();
      environment.dispose(); renderer.dispose(); canvas.remove();
    },
  };
}



