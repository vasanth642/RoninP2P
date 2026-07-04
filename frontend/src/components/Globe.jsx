import React, { useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";

// Individual Dynamic Pulsing/Fading Node Component
function ActivePeerNode({ loc, index }) {
  const [opacity, setOpacity] = useState(0);
  const phaseRef = useRef(Math.random() * 100);
  const stateDurationRef = useRef(4 + Math.random() * 4); // Slightly slower appearance pacing

  useFrame((state) => {
    const elapsed = state.clock.getElapsedTime() + phaseRef.current;
    const cycle = (elapsed % stateDurationRef.current) / stateDurationRef.current;
    const currentOpacity = Math.sin(cycle * Math.PI);
    setOpacity(currentOpacity);
  });

  if (opacity < 0.05) return null;

  return (
    <mesh position={[loc.x, loc.y, loc.z]}>
      <sphereGeometry args={[0.03, 8, 8]} />
      <meshBasicMaterial color="#10b981" transparent opacity={opacity} />
      
      <Html distanceFactor={5.5} center>
        <div 
          className="relative flex items-center justify-center pointer-events-none select-none transition-opacity duration-300"
          style={{ opacity: opacity }}
        >
          {/* Increased pulsing beacon behind avatar */}
          <div className="absolute inset-0 rounded-full h-10 w-10 bg-emerald-500/20 border border-emerald-400/30 animate-pulse"></div>
          
          {/* Increased Node Size: Scaled container up to h-8 w-8 for clear visibility */}
          <div className="relative h-8 w-8 rounded-full border border-zinc-800/80 bg-zinc-950 p-0.5 shadow-xl overflow-hidden">
            <img 
              src={loc.avatar} 
              alt="Peer Node" 
              className="h-full w-full object-cover rounded-full filter grayscale contrast-125"
            />
          </div>
        </div>
      </Html>
    </mesh>
  );
}

// Dynamic Peer-to-Peer Transfer Ray Component
function PeerTransferRay({ startNode, endNode }) {
  const lineRef = useRef();
  const segmentsCount = 25;
  const progressRef = useRef(0);
  // Decreased Line Speed: Cut velocity in half for a smooth, high-fidelity pulse path
  const speedRef = useRef(0.006 + Math.random() * 0.006);

  const curve = useMemo(() => {
    const startVec = new THREE.Vector3(startNode.x, startNode.y, startNode.z);
    const endVec = new THREE.Vector3(endNode.x, endNode.y, endNode.z);
    const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5).normalize().multiplyScalar(2.2);
    return new THREE.QuadraticBezierCurve3(startVec, midPoint, endVec);
  }, [startNode, endNode]);

  const pointsBuffer = useMemo(() => {
    const points = [];
    for (let i = 0; i < segmentsCount; i++) points.push(new THREE.Vector3());
    return points;
  }, []);

  useFrame(() => {
    if (lineRef.current) {
      progressRef.current += speedRef.current;
      
      if (progressRef.current > 1.2) {
        progressRef.current = 0;
        speedRef.current = 0.006 + Math.random() * 0.006;
      }

      for (let i = 0; i < segmentsCount; i++) {
        const offset = (i / segmentsCount) * 0.15;
        const headProgress = Math.max(0, Math.min(1, progressRef.current - offset));
        pointsBuffer[i].copy(curve.getPointAt(headProgress));
      }
      
      lineRef.current.geometry.setFromPoints(pointsBuffer);
    }
  });

  return (
    <line ref={lineRef}>
      <bufferGeometry attach="geometry" />
      <lineBasicMaterial
        attach="material"
        color="#22d3ee"
        transparent
        opacity={progressRef.current > 1.0 ? 0 : 0.8}
        linewidth={2}
      />
    </line>
  );
}

function P2PNetworkGlobe() {
  const globeGroupRef = useRef();

  const peerDirectory = useMemo(() => [
    { x: 0.45, y: 1.45, z: 1.0, avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80" },
    { x: 1.35, y: 0.75, z: -0.8, avatar: "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=100&q=80" },
    { x: 1.2, y: -0.65, z: 1.1, avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=100&q=80" },
    { x: -0.65, y: -1.3, z: 1.1, avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=100&q=80" },
    { x: -1.3, y: 0.8, z: -1.0, avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=100&q=80" },
    { x: -0.25, y: 1.65, z: -0.7, avatar: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=100&q=80" },
    { x: 0.8, y: -1.1, z: -1.2, avatar: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?auto=format&fit=crop&w=100&q=80" },
    { x: -1.45, y: -0.45, z: 0.8, avatar: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=100&q=80" }
  ], []);

  const activeTransfers = useMemo(() => [
    { from: peerDirectory[0], to: peerDirectory[2] },
    { from: peerDirectory[3], to: peerDirectory[1] },
    { from: peerDirectory[4], to: peerDirectory[6] },
    { from: peerDirectory[7], to: peerDirectory[5] },
    { from: peerDirectory[2], to: peerDirectory[5] }
  ], [peerDirectory]);

  useFrame((state) => {
    if (globeGroupRef.current) {
      globeGroupRef.current.rotation.y = state.clock.getElapsedTime() * 0.05;
    }
  });

  return (
    <group ref={globeGroupRef}>
      {/* Balanced Grid Lines: Settled opacity down perfectly to 0.22 so it isn't too bright or too dim */}
      <mesh>
        <sphereGeometry args={[1.85, 32, 32]} />
        <meshBasicMaterial
          color="#10b981"
          wireframe
          transparent
          opacity={0.22}
        />
      </mesh>

      {/* Render the randomized point-to-point laser transfer pipelines */}
      {activeTransfers.map((link, idx) => (
        <PeerTransferRay key={idx} startNode={link.from} endNode={link.to} />
      ))}

      {/* Map out the array of independent pop/fade user nodes */}
      {peerDirectory.map((loc, index) => (
        <ActivePeerNode key={index} loc={loc} index={index} />
      ))}
    </group>
  );
}

export function Globe() {
  return (
    <div className="w-full h-full relative flex items-center justify-center">
      {/* Deep Ambient Bottom Glow Flare Layer */}
      <div className="absolute bottom-[-5%] left-1/2 -translate-x-1/2 w-[380px] h-[160px] bg-emerald-500/10 rounded-full blur-[90px] pointer-events-none z-0"></div>
      
      {/* Balanced layout container box bounding boundaries */}
      <div className="w-full h-[90%] mb-16 relative z-10">
        <Canvas
          camera={{ position: [0, 0, 5.2], fov: 45 }}
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: true }}
        >
          <ambientLight intensity={1.6} />
          <P2PNetworkGlobe />
          <OrbitControls
            enableZoom={false}
            autoRotate={false}
            enablePan={false}
          />
        </Canvas>
      </div>
    </div>
  );
}