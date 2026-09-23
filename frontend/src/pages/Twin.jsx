import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { CHECKLIST } from '../components'

/*
  Digital twin of the machine, driven by live app state.
  Model source: built-in placeholder, OR a Fusion 360 export (FBX/GLB/OBJ) placed at
  frontend/public/models/excavator.fbx|glb, or dropped onto the viewer.
  Parts are found by component name: Upper, Boom, Stick, Bucket, Engine (see fusion/README.md).
*/

const TAIL = 2.3          // tail-swing radius of the upper structure (m)
const DANGER_M = 3        // same zones as the proximity camera
const WARN_M = 6
const CAM_FOV = (60 * Math.PI) / 180
const IDLE_ALERT_S = 20   // demo threshold for "idling" (real: 5 min)
const PAINT = { Beginner: '#7d8083', Intermediate: '#b3a05a', Expert: '#ffcd11' }
const HOTSPOT_LABELS = ['Surroundings', 'Tracks', 'Hydraulics', 'Mirrors & camera', 'Extinguisher', 'Fluid levels']
// Fallback hotspot positions for imported models, as fractions of the model's bounding box
const HOTSPOT_FRAC = [[-0.06, 0.05, 0.5], [0.5, 0.15, 0.97], [0.72, 0.55, 0.5], [0.45, 0.85, 0.9], [0.35, 0.45, 0.97], [0.2, 0.55, 0.9]]

function box(w, h, d, mat, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Simple excavator with the same part names/pivots the Fusion script produces. */
function buildPlaceholder(paintMats) {
  const paint = new THREE.MeshStandardMaterial({ color: PAINT.Intermediate, metalness: 0.3, roughness: 0.5 })
  const engineMat = paint.clone()
  const cabMat = paint.clone()
  paintMats.push(paint, engineMat, cabMat)
  const dark = new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.8 })
  const steel = new THREE.MeshStandardMaterial({ color: '#6b6e72', metalness: 0.6, roughness: 0.4 })
  const glass = new THREE.MeshStandardMaterial({ color: '#1d2a36', metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.75 })

  const root = new THREE.Group()
  root.name = 'Placeholder'
  const base = new THREE.Group(); base.name = 'Base'; root.add(base)
  box(4.4, 0.9, 0.75, dark, 0, 0.45, 1.2, base)
  box(4.4, 0.9, 0.75, dark, 0, 0.45, -1.2, base)
  box(2.2, 0.5, 1.6, steel, 0, 0.7, 0, base)

  const upper = new THREE.Group(); upper.name = 'Upper'; upper.position.y = 1.0; root.add(upper)
  box(3.4, 0.35, 2.6, paint, -0.3, 0.2, 0, upper)
  const cab = box(1.1, 1.6, 1.0, cabMat, 0.75, 1.15, 0.75, upper); cab.name = 'Cab'
  box(0.05, 0.9, 0.85, glass, 1.31, 1.45, 0.75, upper)
  box(0.9, 0.9, 0.05, glass, 0.75, 1.45, 1.26, upper)
  const engine = box(1.5, 0.8, 2.2, engineMat, -1.0, 0.75, -0.1, upper); engine.name = 'Engine'
  box(0.6, 1.0, 2.6, dark, -2.0, 0.7, 0, upper)

  const boom = new THREE.Group(); boom.name = 'Boom'; boom.position.set(1.0, 0.6, -0.2); upper.add(boom)
  box(5.2, 0.5, 0.45, paint, 2.6, 0, 0, boom)
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.4), steel)
  cyl.rotation.z = Math.PI / 2; cyl.position.set(1.4, -0.4, 0); boom.add(cyl)
  const stick = new THREE.Group(); stick.name = 'Stick'; stick.position.set(5.2, 0, 0); boom.add(stick)
  box(3.0, 0.38, 0.35, paint, 1.5, 0, 0, stick)
  const bucket = new THREE.Group(); bucket.name = 'Bucket'; bucket.position.set(3.0, 0, 0); stick.add(bucket)
  box(0.9, 0.7, 1.0, dark, 0.35, -0.25, 0, bucket)

  // Hotspot anchors ride on the part they belong to (so they swing with the machine)
  const anchor = (parent, x, y, z) => { const a = new THREE.Object3D(); a.position.set(x, y, z); parent.add(a); return a }
  const anchors = [
    anchor(root, -4.4, 0.3, 0), anchor(base, 1.6, 1.0, 1.6), anchor(boom, 1.4, -0.2, 0.3),
    anchor(upper, 1.35, 1.9, 1.3), anchor(upper, 0.1, 0.9, 1.35), anchor(upper, -1.0, 1.2, 1.2),
  ]
  const cabEye = anchor(upper, 0.8, 1.75, 0.75)
  const cabLook = anchor(upper, 7, 0.2, 0)
  const beaconAnchor = anchor(upper, 0.75, 2.05, 0.75)
  return { root, parts: { upper, boom, stick, bucket, engine, cab }, anchors, cabEye, cabLook, beaconAnchor }
}

const isDescendant = (child, parent) => { let p = child?.parent; while (p) { if (p === parent) return true; p = p.parent } return false }

/** Prepare an imported Fusion model: scale to metres, sit on ground, find parts, add anchors. */
function adoptImported(obj, zUp, paintMats) {
  const holder = new THREE.Group()
  holder.name = 'Imported'
  if (zUp) obj.rotation.x = -Math.PI / 2
  holder.add(obj)
  obj.updateMatrixWorld(true)
  let bb = new THREE.Box3().setFromObject(obj)
  const size = bb.getSize(new THREE.Vector3())
  const s = 9.5 / Math.max(size.x, size.z, 1e-6) // real excavator ~9.5 m long
  obj.scale.multiplyScalar(s)
  obj.updateMatrixWorld(true)
  bb = new THREE.Box3().setFromObject(obj)
  const c = bb.getCenter(new THREE.Vector3())
  obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= bb.min.y
  obj.updateMatrixWorld(true)
  bb = new THREE.Box3().setFromObject(obj)

  const find = (re) => { let f = null; obj.traverse((n) => { if (!f && re.test(n.name)) f = n }); return f }
  const upper = find(/upper|house|superstructure/i)
  const boom = find(/boom/i)
  const stick = find(/stick|dipper|\barm/i)
  const bucket = find(/bucket/i)
  // Glow effects need their own material, so take the first mesh and clone its material.
  const ownMesh = (n) => {
    let mesh = n?.isMesh ? n : null
    n?.traverse((c) => { if (!mesh && c.isMesh) mesh = c })
    if (mesh && !Array.isArray(mesh.material)) mesh.material = mesh.material.clone()
    return mesh
  }
  const engine = ownMesh(find(/engine/i))
  const cab = ownMesh(find(/cab/i))
  obj.traverse((n) => {
    n.castShadow = n.receiveShadow = true
    const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : []
    mats.forEach((m) => { if (/paint|cat.?yellow|yellow/i.test(m.name)) paintMats.push(m) })
  })
  // Only animate joints that are properly nested, otherwise parts would detach.
  const nested = !!(boom && stick && isDescendant(stick, boom))
  const parts = {
    upper: upper && boom && isDescendant(boom, upper) ? upper : null,
    boom: nested ? boom : null,
    stick: nested ? stick : null,
    bucket: nested && bucket && isDescendant(bucket, stick) ? bucket : null,
    engine, cab,
  }
  const found = { Upper: !!upper, Boom: !!boom, Stick: !!stick, Bucket: !!bucket, Engine: !!engine, Nested: !!parts.stick }
  const at = ([fx, fy, fz]) => {
    const a = new THREE.Object3D()
    a.position.set(bb.min.x + fx * (bb.max.x - bb.min.x), bb.min.y + fy * (bb.max.y - bb.min.y), bb.min.z + fz * (bb.max.z - bb.min.z))
    holder.add(a)
    return a
  }
  const anchors = HOTSPOT_FRAC.map(at)
  // Remember rest pose for animated joints
  Object.values(parts).forEach((p) => { if (p) p.userData.rest = p.rotation.clone() })
  return { root: holder, parts, anchors, cabEye: at([0.45, 0.8, 0.75]), cabLook: at([1.6, 0.1, 0.5]), beaconAnchor: at([0.45, 1.02, 0.8]), found, zUp }
}

async function parseModel(buffer, name) {
  const ext = name.split('.').pop().toLowerCase()
  if (ext === 'fbx') return new FBXLoader().parse(buffer, '')
  if (ext === 'glb' || ext === 'gltf') {
    return new Promise((res, rej) => new GLTFLoader().parse(buffer, '', (g) => res(g.scene), rej))
  }
  if (ext === 'obj') return new OBJLoader().parse(new TextDecoder().decode(buffer))
  throw new Error(`Unsupported file type .${ext}: export FBX from Fusion 360`)
}

const looksLikeModel = (buf, ext) => {
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 20)))
  return ext === 'fbx' ? head.startsWith('Kaydara FBX') || head.startsWith('; FBX') : head.startsWith('glTF')
}

export default function Twin({ schedule, profile, seatbelt, engineOn, proximity, fatigue, checks, toggleCheck, onProximity, notify }) {
  const mountRef = useRef(null)
  const labelRefs = useRef([])
  const three = useRef({})
  const live = useRef({})
  const [view, setView] = useState('orbit')
  const [source, setSource] = useState({ kind: 'placeholder' })
  const [zUp, setZUp] = useState(false)
  const [idleS, setIdleS] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const lastFile = useRef(null)
  const simRef = useRef(null)

  const activeTask = schedule?.tasks.find((t) => t.status === 'in_progress')
  const blockers = []
  if (seatbelt !== 'Fastened') blockers.push('Seatbelt unfastened')
  if (proximity.level === 'danger') blockers.push(`Person ${proximity.distance?.toFixed(1)} m from machine`)
  if (fatigue.level === 'microsleep' || fatigue.level === 'drowsy') blockers.push('Operator drowsy')
  const working = !!activeTask && engineOn
  const frozen = working && blockers.length > 0

  live.current = { working, frozen, engineOn, proximity, fatigue, checks, view, skill: profile?.skill || 'Intermediate', idleS }

  // Idle timer: engine on, no task running
  useEffect(() => {
    if (working || !engineOn) { setIdleS(0); return }
    const t = setInterval(() => setIdleS((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [working, engineOn])

  // ---------------------------------------------------------------- scene setup (once)
  useEffect(() => {
    const el = mountRef.current
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#17181b')
    scene.fog = new THREE.Fog('#17181b', 30, 70)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200)
    camera.position.set(12, 8, 12)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(1, 1.5, 0)
    controls.maxPolarAngle = Math.PI / 2.05
    controls.enableDamping = true

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3226, 1.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.7)
    sun.position.set(10, 16, 7)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15 })
    scene.add(sun)

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ color: '#5b4a36', roughness: 1 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)
    const grid = new THREE.GridHelper(90, 45, 0x7a6a55, 0x6a5a45)
    grid.material.transparent = true
    grid.material.opacity = 0.25
    grid.position.y = 0.01
    scene.add(grid)

    const ring = (r, color, width = 0.14) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r - width, r, 128), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }))
      m.rotation.x = -Math.PI / 2; m.position.y = 0.03; scene.add(m); return m
    }
    const disc = (r, color) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(r, 128), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, side: THREE.DoubleSide }))
      m.rotation.x = -Math.PI / 2; m.position.y = 0.02; scene.add(m); return m
    }
    const dangerRing = ring(TAIL + DANGER_M, '#ff4d4f')
    const dangerDisc = disc(TAIL + DANGER_M, '#ff4d4f')
    const warnRing = ring(TAIL + WARN_M, '#ffa62b', 0.08)

    const worker = new THREE.Group()
    const vest = new THREE.MeshStandardMaterial({ color: '#ff7a00', emissive: '#552200' })
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.1, 16), vest); body.position.y = 0.85; body.castShadow = true
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 16), new THREE.MeshStandardMaterial({ color: '#c68642' })); head.position.y = 1.55
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#ffffff' })); helmet.position.y = 1.6
    worker.add(body, head, helmet)
    worker.visible = false
    scene.add(worker)

    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 16), new THREE.MeshStandardMaterial({ color: '#333', emissive: '#000' }))
    const hotMat = () => new THREE.MeshStandardMaterial({ color: '#ffa62b', emissive: '#ffa62b', emissiveIntensity: 0.8, transparent: true, opacity: 0.9 })
    const hotspots = HOTSPOT_LABELS.map(() => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), hotMat()); scene.add(s); return s })

    const t = three.current
    Object.assign(t, { renderer, scene, camera, controls, dangerRing, dangerDisc, warnRing, worker, beacon, hotspots, paintMats: [], model: null })
    t.setModel = (m) => {
      if (t.model) scene.remove(t.model.root)
      t.model = m
      scene.add(m.root)
      m.beaconAnchor.add(beacon)
      beacon.position.set(0, 0, 0)
    }
    t.setModel(buildPlaceholder(t.paintMats))

    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    // ---------------------------------------------------------------- render loop
    const clock = new THREE.Clock()
    let dig = 0
    let raf
    const v = new THREE.Vector3()
    const paintTarget = new THREE.Color()
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(clock.getDelta(), 0.05)
      const now = clock.elapsedTime
      const L = live.current
      const m = t.model
      const p = m.parts

      // Dig cycle only while a task runs and nothing blocks it (interlock = frozen)
      if (L.working && !L.frozen) dig += dt
      const w = 1.1
      const rest = (n) => n.userData.rest || new THREE.Euler()
      const zAx = m.zUp ? 'y' : 'z'
      const yAx = m.zUp ? 'z' : 'y'
      let swing = 0
      if (p.upper) { swing = 0.55 * Math.sin(dig * 0.45); p.upper.rotation[yAx] = rest(p.upper)[yAx] + swing }
      if (p.boom) p.boom.rotation[zAx] = (p.boom.userData.rest ? rest(p.boom)[zAx] : 0.45) + 0.2 * Math.sin(dig * w)
      if (p.stick) p.stick.rotation[zAx] = (p.stick.userData.rest ? rest(p.stick)[zAx] : -1.9) + 0.35 * Math.sin(dig * w + 1)
      if (p.bucket) p.bucket.rotation[zAx] = (p.bucket.userData.rest ? rest(p.bucket)[zAx] : -0.8) + 0.5 * Math.sin(dig * w + 2)

      // Heritage paint: gray (beginner) -> CAT yellow (expert)
      paintTarget.set(PAINT[L.skill] || PAINT.Intermediate)
      t.paintMats.forEach((pm) => pm.color?.lerp(paintTarget, 0.04))

      // Engine glows when idling too long; cab flashes on drowsiness
      const idleHot = L.engineOn && !L.working && L.idleS >= IDLE_ALERT_S
      if (p.engine?.material) {
        const em = p.engine.material
        em.emissive?.set(idleHot ? '#ff5a00' : '#000000')
        if (em.emissive) em.emissiveIntensity = idleHot ? 0.5 + 0.4 * Math.sin(now * 4) : 0
      }
      if (p.cab?.material?.emissive) {
        const drowsy = L.fatigue.level === 'microsleep' || L.fatigue.level === 'drowsy'
        p.cab.material.emissive.set(drowsy ? '#ff2020' : '#000000')
        p.cab.material.emissiveIntensity = drowsy ? 0.6 * (Math.sin(now * 10) > 0 ? 1 : 0.2) : 0
      }
      // Beacon: red flashing = blocked, amber = working, dark = idle
      const bm = t.beacon.material
      const flash = Math.sin(now * 8) > 0
      bm.emissive.set(L.frozen ? (flash ? '#ff2020' : '#300000') : L.working ? (flash ? '#ffb000' : '#402800') : '#000000')
      bm.emissiveIntensity = 1.5

      // Zones + worker from the proximity camera (camera looks out of the rear of the upper structure)
      const prox = L.proximity
      const danger = prox.level === 'danger'
      t.dangerRing.material.opacity = danger ? 0.6 + 0.4 * Math.sin(now * 10) : 0.85
      t.dangerDisc.material.opacity = danger ? 0.28 : prox.level === 'warn' ? 0.14 : 0.08
      t.warnRing.material.opacity = prox.level === 'warn' ? 1 : 0.5
      if (prox.distance != null) {
        const r = TAIL + prox.distance
        const off = ((prox.x ?? 0.5) - 0.5) * CAM_FOV
        v.set(-r * Math.cos(off), 0, r * Math.sin(off)).applyAxisAngle(new THREE.Vector3(0, 1, 0), swing)
        t.worker.position.lerp(v, 0.3)
        t.worker.lookAt(0, 0, 0)
        t.worker.visible = true
      } else t.worker.visible = false

      // Walkaround hotspots + screen-space labels
      m.anchors.forEach((a, i) => {
        a.getWorldPosition(v)
        const s = t.hotspots[i]
        s.position.copy(v)
        const ok = L.checks.includes(i)
        s.material.color.set(ok ? '#3ecf6e' : '#ffa62b')
        s.material.emissive.set(ok ? '#1f7a40' : '#ffa62b')
        s.scale.setScalar(ok ? 1 : 1 + 0.25 * Math.sin(now * 5 + i))
        const lbl = labelRefs.current[i]
        if (lbl) {
          const pr = v.clone().project(camera)
          const visible = pr.z < 1 && L.view !== 'cab'
          lbl.style.display = visible ? 'block' : 'none'
          lbl.style.left = `${((pr.x + 1) / 2) * el.clientWidth}px`
          lbl.style.top = `${((1 - pr.y) / 2) * el.clientHeight}px`
        }
      })

      // Camera modes
      if (L.view === 'cab') {
        m.cabEye.getWorldPosition(camera.position)
        m.cabLook.getWorldPosition(v)
        camera.lookAt(v)
      } else controls.update()
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])

  // View presets
  useEffect(() => {
    const { camera, controls } = three.current
    if (!camera) return
    controls.enabled = view !== 'cab'
    if (view === 'orbit') { camera.position.set(12, 8, 12); controls.target.set(1, 1.5, 0) }
    if (view === 'top') { camera.position.set(0.01, 26, 0.01); controls.target.set(0, 0, 0) }
  }, [view])

  // ---------------------------------------------------------------- Fusion 360 model loading
  const loadBuffer = async (buf, name, up = zUp) => {
    try {
      const obj = await parseModel(buf, name)
      const t = three.current
      t.paintMats.length = 0
      const m = adoptImported(obj, up, t.paintMats)
      t.setModel(m)
      lastFile.current = { buf, name }
      setSource({ kind: 'fusion', name, found: m.found })
      notify?.(`🧊 Loaded ${name}: ${Object.entries(m.found).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no named parts'}`)
    } catch (e) {
      notify?.(`⚠️ Could not load ${name}: ${e.message}`)
    }
  }
  useEffect(() => {
    // Auto-load a Fusion export dropped into public/models/
    (async () => {
      for (const name of ['excavator.fbx', 'excavator.glb']) {
        try {
          const r = await fetch(`/models/${name}`)
          if (!r.ok) continue
          const buf = await r.arrayBuffer()
          if (looksLikeModel(buf, name.split('.').pop())) { await loadBuffer(buf, name); return }
        } catch { /* not present */ }
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (file) => {
    if (!file) return
    await loadBuffer(await file.arrayBuffer(), file.name)
  }
  const usePlaceholder = () => {
    const t = three.current
    t.paintMats.length = 0
    t.setModel(buildPlaceholder(t.paintMats))
    setSource({ kind: 'placeholder' })
  }
  const flipUp = () => {
    const next = !zUp
    setZUp(next)
    if (lastFile.current) loadBuffer(lastFile.current.buf, lastFile.current.name, next)
  }

  // Worker walk-around simulation (feeds the same proximity state as the camera)
  const simulateWorker = () => {
    clearInterval(simRef.current)
    let s = 0
    simRef.current = setInterval(() => {
      s += 0.1
      const dist = s < 4 ? 9 - s * 1.9 : s < 7 ? 1.4 + Math.sin(s * 3) * 0.2 : 1.4 + (s - 7) * 2.6
      const x = 0.2 + 0.6 * (s / 10)
      if (s > 10) { clearInterval(simRef.current); onProximity({ level: 'clear', distance: null }); return }
      onProximity({ level: dist < DANGER_M ? 'danger' : dist < WARN_M ? 'warn' : 'clear', distance: dist, x })
    }, 100)
  }
  useEffect(() => () => clearInterval(simRef.current), [])

  const fmtIdle = `${Math.floor(idleS / 60)}:${String(idleS % 60).padStart(2, '0')}`
  const state = [
    { k: 'Engine', v: engineOn ? '⚙️ Running' : '⏻ Off', c: engineOn ? 'good' : '' },
    { k: 'Machine', v: !engineOn ? 'Parked' : frozen ? '⛔ Motion inhibited' : working ? `⚙️ Working: ${activeTask.task_type}` : idleS >= IDLE_ALERT_S ? `🔥 Idling ${fmtIdle}` : `💤 Idle ${fmtIdle}`, c: frozen ? 'bad' : working ? 'good' : idleS >= IDLE_ALERT_S ? 'warn' : '' },
    { k: 'Seatbelt', v: seatbelt === 'Fastened' ? '✓ Fastened' : '✗ Unfastened', c: seatbelt === 'Fastened' ? 'good' : 'bad' },
    { k: 'Swing zone', v: proximity.level === 'danger' ? `🛑 Person ${proximity.distance?.toFixed(1)} m` : proximity.level === 'warn' ? `⚠️ Person ${proximity.distance?.toFixed(1)} m` : '✓ Clear', c: proximity.level === 'danger' ? 'bad' : proximity.level === 'warn' ? 'warn' : 'good' },
    { k: 'Operator', v: fatigue.level === 'off' ? 'Monitor off' : fatigue.level, c: ['microsleep', 'drowsy'].includes(fatigue.level) ? 'bad' : fatigue.level === 'tired' ? 'warn' : 'good' },
    { k: 'Walkaround', v: `${checks.length}/${CHECKLIST.length} checked`, c: checks.length === CHECKLIST.length ? 'good' : 'warn' },
    { k: 'Paint', v: `${profile?.skill || '…'} (${profile?.skill === 'Expert' ? 'CAT yellow' : profile?.skill === 'Beginner' ? 'steel gray' : 'transition'})`, c: '' },
  ]

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="split">
        <div className="card hero" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            ref={mountRef}
            className={`twin-view ${dragOver ? 'drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files[0]) }}
          >
            {HOTSPOT_LABELS.map((l, i) => (
              <button key={l} ref={(r) => { labelRefs.current[i] = r }} className={`hotspot ${checks.includes(i) ? 'on' : ''}`}
                onClick={() => toggleCheck(i)} title={CHECKLIST[i]}>
                {checks.includes(i) ? '✓' : i + 1} {l}
              </button>
            ))}
            {frozen && <div className="twin-banner">⛔ MOTION INHIBITED: {blockers.join(' · ')}</div>}
            {engineOn && !working && idleS >= IDLE_ALERT_S && !frozen && (
              <div className="twin-banner warn">🔥 Engine idling {fmtIdle}. Burning ~3.5 L/h (≈ ₹5/min). Shut down if waiting over 5 min.</div>
            )}
          </div>
          <div className="row wrap" style={{ padding: 12, gap: 8 }}>
            {[['orbit', '🔄 Orbit'], ['top', '🗺️ Top view'], ['cab', '🪟 Operator view']].map(([k, l]) => (
              <button key={k} className={`btn sm ${view === k ? 'primary' : ''}`} onClick={() => setView(k)}>{l}</button>
            ))}
            <div className="spacer" />
            <button className="btn sm" onClick={simulateWorker}>🚶 Simulate worker</button>
          </div>
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <h3>🚜 Live machine state</h3>
            {state.map((s) => (
              <div key={s.k} className="row small" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="muted">{s.k}</span>
                <span className={`chip ${s.c}`} style={{ textTransform: s.k === 'Operator' ? 'capitalize' : undefined }}>{s.v}</span>
              </div>
            ))}
            <p className="small muted" style={{ marginBottom: 0 }}>
              The twin mirrors the app live: it digs while a task runs, <b>freezes</b> on any interlock (belt, person, drowsiness),
              the <b>engine glows</b> when idling, and the <b>paint shifts from gray to yellow</b> as your skill grows. Click the numbered
              hotspots to do the walkaround.
            </p>
          </div>

          <div className="card">
            <h3>🧊 Model source</h3>
            {source.kind === 'placeholder' ? (
              <div className="small">Built-in placeholder. <span className="muted">Load your Fusion 360 export to replace it.</span></div>
            ) : (
              <div className="small">
                <b>Fusion 360 export:</b> {source.name}
                <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                  {Object.entries(source.found).map(([k, v]) => <span key={k} className={`chip ${v ? 'good' : 'warn'}`}>{v ? '✓' : '✗'} {k}</span>)}
                </div>
                {!source.found.Nested && <div className="muted" style={{ marginTop: 6 }}>Joints not nested (Upper › Boom › Stick › Bucket), so the arm is shown static. See fusion/README.md.</div>}
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
              <label className="btn sm primary" style={{ cursor: 'pointer' }}>
                📂 Load .fbx / .glb / .obj
                <input type="file" accept=".fbx,.glb,.gltf,.obj" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files[0])} />
              </label>
              {source.kind === 'fusion' && <button className="btn sm" onClick={flipUp}>↻ {zUp ? 'Model is Y-up' : 'Model is Z-up'}</button>}
              {source.kind === 'fusion' && <button className="btn sm ghost" onClick={usePlaceholder}>Use placeholder</button>}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>Or drag a file onto the 3D view, or save it as <code>frontend/public/models/excavator.fbx</code> to load automatically.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
