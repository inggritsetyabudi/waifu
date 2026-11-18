/**
 * VRM avatar renderer (three.js + @pixiv/three-vrm).
 * Parallel avatar path to Live2D. Provides the same Director interface.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

export interface VRMDirector {
  setEmotion(primary: string, intensity: number): void;
  startLipSync(): void;
  feedLipSync(level: number): void;
  stopLipSync(): void;
  gesture(gesture: string): void;
}

const EMOTION_TO_VRM: Record<string, { preset?: string; blinkOff?: boolean }> = {
  happy: { preset: "happy" },
  excited: { preset: "happy" },
  shy: { preset: "relaxed" },
  embarrassed: { preset: "relaxed" },
  sad: { preset: "sad" },
  angry: { preset: "angry" },
  annoyed: { preset: "angry" },
  surprised: { preset: "surprised" },
};

export class VRMStage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  vrm: VRM | null = null;
  clock = new THREE.Clock();

  private currentEmotion = "";
  private emotionWeight = 0;
  private targetWeight = 0;
  private mouthLevel = 0;
  private rafId = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 1.3, 2.4);

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(1, 1.5, 2);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    this.resize();
    this.loop();
  }

  async load(url: string, scale = 1) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);

    this.scene.remove(this.vrm?.scene ?? new THREE.Object3D());
    vrm.scene.scale.setScalar(scale);
    this.scene.add(vrm.scene);
    this.vrm = vrm;
    this.resize();
  }

  setEmotion(primary: string, intensity: number) {
    this.currentEmotion = primary;
    this.targetWeight = intensity;
  }

  feedLipSync(level: number) {
    this.mouthLevel = level;
  }

  stopLipSync() {
    this.mouthLevel = 0;
  }

  gesture(_gesture: string) {
    // procedural gestures land in phase 4; safe no-op for now
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();

    if (this.vrm) {
      const em = this.vrm.expressionManager;
      if (em) {
        this.emotionWeight +=
          (this.targetWeight - this.emotionWeight) * Math.min(1, dt * 6);
        // reset previous then set current
        for (const { preset } of Object.values(EMOTION_TO_VRM)) {
          if (preset && preset !== EMOTION_TO_VRM[this.currentEmotion]?.preset) {
            em.setValue(preset as never, 0);
          }
        }
        const preset = EMOTION_TO_VRM[this.currentEmotion]?.preset;
        if (preset) em.setValue(preset as never, this.emotionWeight);

        // blink
        const t = this.clock.elapsedTime;
        const blink = Math.max(
          0,
          Math.sin(t * 2.1) > 0.996 ? Math.sin(((t * 2.1) % Math.PI) * 300) : 0,
        );
        em.setValue("blink", blink);

        // mouth: AA driven by audio level
        em.setValue("aa", Math.min(1, this.mouthLevel) as never);
      }

      // subtle idle sway
      const hips = this.vrm.humanoid?.getNormalizedBoneNode("hips");
      if (hips) {
        hips.rotation.z = Math.sin(this.clock.elapsedTime * 0.5) * 0.015;
      }
      this.vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.parentElement?.clientWidth || 640;
    const h = canvas.parentElement?.clientHeight || 480;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
  }
}
