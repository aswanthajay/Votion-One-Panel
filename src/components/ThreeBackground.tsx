import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const ServerGrid = () => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  
  const gridSize = 24;
  const count = gridSize * gridSize;

  useFrame((state) => {
    if (meshRef.current) {
      let i = 0;
      for (let x = 0; x < gridSize; x++) {
        for (let z = 0; z < gridSize; z++) {
          const xPos = (x - gridSize / 2) * 1.2;
          const zPos = (z - gridSize / 2) * 1.2;
          
          // Gentle undulating wave math
          const wave = Math.sin(xPos * 0.15 + state.clock.elapsedTime * 0.5) * 
                       Math.cos(zPos * 0.15 + state.clock.elapsedTime * 0.5);
          
          dummy.position.set(xPos, wave * 0.5 - 2, zPos);
          dummy.scale.set(1, 3 + wave, 1);
          dummy.updateMatrix();
          meshRef.current.setMatrixAt(i++, dummy.matrix);
        }
      }
      meshRef.current.instanceMatrix.needsUpdate = true;
      
      // Extremely slow rotation for a premium feel
      meshRef.current.rotation.y = state.clock.elapsedTime * 0.01;
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[null as any, null as any, count]}>
      <boxGeometry args={[0.8, 1, 0.8]} />
      <meshStandardMaterial 
        color="#ffffff" 
        roughness={0.2} 
        metalness={0.1}
      />
    </instancedMesh>
  );
};

export const ThreeBackground: React.FC = () => {
  return (
    <div className="absolute inset-0 w-full h-full z-0 bg-[#fbfaf9] overflow-hidden pointer-events-none">
      <Canvas camera={{ position: [0, 6, 12], fov: 40 }} dpr={[1, 2]}>
        <fog attach="fog" args={['#fbfaf9', 8, 25]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 20, 10]} intensity={1.2} color="#ffffff" />
        <directionalLight position={[-10, 5, -10]} intensity={0.5} color="#e5e7eb" />
        <ServerGrid />
      </Canvas>
    </div>
  );
};
