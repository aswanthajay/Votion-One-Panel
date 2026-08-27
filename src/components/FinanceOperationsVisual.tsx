import React, { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface FinancePalette {
  core: string;
  accent: string;
}

const lightPalette: FinancePalette = {
  core: '#a7aaaa',
  accent: '#8b5e00',
};

const darkPalette: FinancePalette = {
  core: '#9b9b96',
  accent: '#d4a84f',
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
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (reducedMotion) return;

    const time = clock.getElapsedTime();
    if (coreRef.current) {
      const pulse = 1 + Math.sin(time * 0.65) * 0.012;
      coreRef.current.scale.setScalar(pulse);
    }
    if (ringRef.current) {
      ringRef.current.rotation.y = time * 0.07;
      ringRef.current.rotation.x = 0.58 + Math.sin(time * 0.22) * 0.025;
    }
  });

  return (
    <>
      <ambientLight intensity={0.42} />
      <directionalLight position={[2, 3, 4]} intensity={0.85} color={palette.core} />
      <pointLight position={[-1.5, 1, 2]} intensity={1.1} distance={5} color={palette.accent} />
      <mesh ref={coreRef}>
        <sphereGeometry args={[0.48, 24, 18]} />
        <meshStandardMaterial color={palette.core} metalness={0.42} roughness={0.58} />
      </mesh>
      <mesh ref={ringRef} rotation={[0.58, 0.18, -0.22]}>
        <torusGeometry args={[0.78, 0.009, 8, 64]} />
        <meshStandardMaterial color={palette.accent} metalness={0.7} roughness={0.48} />
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
