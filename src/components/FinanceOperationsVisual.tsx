import React, { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface FinancePalette {
  core: string;
  accent: string;
  secondary: string;
}

const lightPalette: FinancePalette = {
  core: '#1a1a1a',
  accent: '#8b5e00',
  secondary: '#a7aaaa',
};

const darkPalette: FinancePalette = {
  core: '#ededed',
  accent: '#f3c56b',
  secondary: '#71717a',
};

const useReducedMotion = () => {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reducedMotion;
};

const FinanceScene: React.FC<{ palette: FinancePalette; reducedMotion: boolean }> = ({ palette, reducedMotion }) => {
  const coreRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (reducedMotion) return;

    const time = clock.getElapsedTime();
    if (coreRef.current) {
      const pulse = 1 + Math.sin(time * 1.2) * 0.025;
      coreRef.current.scale.setScalar(pulse);
    }
    if (ringRef.current) {
      ringRef.current.rotation.y = time * 0.14;
      ringRef.current.rotation.z = Math.sin(time * 0.28) * 0.06;
    }
  });

  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight position={[3, 4, 5]} intensity={1.7} color={palette.core} />
      <pointLight position={[-2, 1, 2]} intensity={4} distance={7} color={palette.accent} />
      <mesh ref={coreRef}>
        <sphereGeometry args={[0.56, 32, 32]} />
        <meshStandardMaterial color={palette.core} metalness={0.8} roughness={0.24} emissive={palette.accent} emissiveIntensity={0.08} />
      </mesh>
      <group ref={ringRef} rotation={[0.58, 0.18, -0.22]}>
        <mesh>
          <torusGeometry args={[0.9, 0.018, 12, 96]} />
          <meshStandardMaterial color={palette.accent} metalness={0.9} roughness={0.22} emissive={palette.accent} emissiveIntensity={0.1} />
        </mesh>
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.9, 0]}>
        <planeGeometry args={[3.4, 2.1]} />
        <meshStandardMaterial color={palette.secondary} metalness={0.2} roughness={0.9} transparent opacity={0.08} />
      </mesh>
    </>
  );
};

export const FinanceOperationsVisual: React.FC = () => {
  const [isDark, setIsDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.dataset.theme === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const palette = isDark ? darkPalette : lightPalette;

  return (
    <div className="billing-finance-visual" role="img" aria-label="Abstract animated finance operations visualization">
      <div className="billing-finance-visual-label" aria-hidden="true">
        <span>Finance operations</span>
        <strong>LIVE SYSTEM</strong>
      </div>
      <div className="billing-finance-visual-fallback" aria-hidden="true">
        <span className="billing-finance-fallback-ring" />
        <span className="billing-finance-fallback-core" />
      </div>
      <Canvas camera={{ position: [0, 0, 4.6], fov: 32 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }}>
        <FinanceScene palette={palette} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
};
