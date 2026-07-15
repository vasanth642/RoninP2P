import React, { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";

function ActivePeerNode({ loc }) {
  const meshRef = useRef();
  const htmlRef = useRef();
  const phase = useMemo(() => Math.random() * 100, []);
  const duration = useMemo(() => 4 + Math.random() * 4, []);

  useFrame((state) => {
    if (!meshRef.current || !htmlRef.current) return;
    
    const elapsed = state.clock.getElapsedTime() + phase;
    const cycle = (elapsed % duration) / duration;
    const currentOpacity = Math.sin(cycle * Math.PI);

    if (meshRef.current.material) {
      meshRef.current.material.opacity = Math.max(0.1, currentOpacity);
    }
    
    htmlRef.current.style.opacity = Math.max(0.2, currentOpacity);
  });

  return (
    <mesh ref={meshRef} position={[loc.x, loc.y, loc.z]}>
      <sphereGeometry args={[0.025, 8, 8]} />
      <meshBasicMaterial color="#22d3ee" transparent opacity={0} />
      
      <Html distanceFactor={5.5} center>
        <div 
          ref={htmlRef}
          className="relative flex items-center justify-center pointer-events-none select-none transition-opacity duration-150 ease-out"
          style={{ opacity: 0 }}
        >
          <div className="absolute inset-0 rounded-full h-10 w-10 bg-indigo-500/20 border border-indigo-400/40 animate-pulse"></div>
          
          <div className="relative h-8 w-8 rounded-full border border-zinc-700 bg-zinc-950 p-0.5 shadow-2xl overflow-hidden">
            <img 
              src={loc.avatar} 
              alt="Peer Node" 
              className="h-full w-full object-cover rounded-full contrast-110 brightness-110"
            />
          </div>
        </div>
      </Html>
    </mesh>
  );
}

function PeerTransferRay({ startNode, endNode }) {
  const lineRef = useRef();
  const segmentsCount = 25;
  const progressRef = useRef(0);
  const speedRef = useRef(0.006 + Math.random() * 0.006);

  const curve = useMemo(() => {
    const startVec = new THREE.Vector3(startNode.x, startNode.y, startNode.z);
    const endVec = new THREE.Vector3(endNode.x, endNode.y, endNode.z);
    const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5).normalize().multiplyScalar(1.95);
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
        opacity={0.8}
        linewidth={2}
      />
    </line>
  );
}

function P2PNetworkGlobe() {
  const globeGroupRef = useRef();

  const peerDirectory = useMemo(() => [
    { x: 0.4, y: 1.3, z: 0.9, avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80" },
    { x: 1.2, y: 0.65, z: -0.7, avatar: "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=100&q=80" },
    { x: 1.05, y: -0.55, z: 1.0, avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=100&q=80" },
    { x: -0.55, y: -1.15, z: 1.0, avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=100&q=80" },
    { x: -1.15, y: 0.7, z: -0.9, avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=100&q=80" },
    { x: -0.2, y: 1.45, z: -0.6, avatar: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=100&q=80" },
    { x: 0.7, y: -0.95, z: -1.0, avatar: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?auto=format&fit=crop&w=100&q=80" },
    { x: -1.3, y: -0.4, z: 0.7, avatar: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=100&q=80" }
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
      {/* High-Contrast Crisp White Globe Structure */}
      <mesh>
        <sphereGeometry args={[1.65, 32, 32]} />
        <meshBasicMaterial
          color="#ffffff"
          wireframe
          transparent
          opacity={0.18}
        />
      </mesh>

      {activeTransfers.map((link, idx) => (
        <PeerTransferRay key={idx} startNode={link.from} endNode={link.to} />
      ))}

      {peerDirectory.map((loc, index) => (
        <ActivePeerNode key={index} loc={loc} />
      ))}
    </group>
  );
}

export function Globe() {
  return (
    <div className="w-full h-full relative flex items-center justify-center overflow-visible">
      {/* Unified Atmospheric Backing Light */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-indigo-500/[0.04] rounded-full blur-[100px] pointer-events-none z-0"></div>
      
      <div className="w-full h-full relative z-10 overflow-visible">
        <Canvas
          camera={{ position: [0, -0.25, 5.2], fov: 45 }}
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: true }}
        >
          <ambientLight intensity={1.8} />
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