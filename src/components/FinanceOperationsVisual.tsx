import React, { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Sparkles } from '@react-three/drei';
import * as THREE from 'three';

interface FinancePalette {
  core: string;
  accent: string;
  secondary: string;
  glow: string;
}

const lightPalette: FinancePalette = {
  core: '#1a1a1a',
  accent: '#8b5e00',
  secondary: '#2563eb',
  glow: '#d4a84f',
};

const darkPalette: FinancePalette = {
  core: '#ededed',
  accent: '#f3c56b',
  secondary: '#a1a1aa',
  glow: '#d4a84f',
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
  const orbitRef = useRef<THREE.Group>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const barsRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (reducedMotion) return;

    const time = clock.getElapsedTime();
    if (orbitRef.current) {
      orbitRef.current.rotation.y = time * 0.18;
      orbitRef.current.rotation.x = Math.sin(time * 0.32) * 0.08;
    }
    if (pulseRef.current) {
      const pulse = 1 + Math.sin(time * 1.4) * 0.035;
      pulseRef.current.scale.setScalar(pulse);
    }
    if (barsRef.current) {
      barsRef.current.children.forEach((bar, index) => {
        bar.scale.y = 0.75 + (Math.sin(time * 1.1 + index * 0.7) + 1) * 0.1;
      });
    }
  });

  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight position={[3, 4, 5]} intensity={2.1} color={palette.core} />
      <pointLight position={[-2, 1, 2]} intensity={8} distance={8} color={palette.glow} />
      <Float speed={reducedMotion ? 0 : 1.1} rotationIntensity={reducedMotion ? 0 : 0.12} floatIntensity={reducedMotion ? 0 : 0.18}>
        <group ref={orbitRef}>
          <mesh ref={pulseRef}>
            <icosahedronGeometry args={[0.62, 1]} />
            <meshStandardMaterial color={palette.core} metalness={0.86} roughness={0.22} emissive={palette.secondary} emissiveIntensity={0.12} />
          </mesh>

          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.92, 0.025, 12, 96]} />
            <meshStandardMaterial color={palette.accent} metalness={0.9} roughness={0.2} emissive={palette.accent} emissiveIntensity={0.18} />
          </mesh>
          <mesh rotation={[0.62, 0.4, 0.18]}>
            <torusGeometry args={[1.13, 0.018, 12, 96]} />
            <meshStandardMaterial color={palette.secondary} metalness={0.8} roughness={0.24} />
          </mesh>
          <mesh rotation={[-0.52, 0.18, 0.76]}>
            <torusGeometry args={[1.32, 0.012, 10, 96]} />
            <meshStandardMaterial color={palette.accent} metalness={0.8} roughness={0.28} transparent opacity={0.62} />
          </mesh>

          <group ref={barsRef} position={[-1.18, -0.7, -0.45]}>
            {[0.48, 0.7, 0.58, 0.88, 0.66].map((height, index) => (
              <mesh key={index} position={[index * 0.18, height * 0.32, 0]} scale={[0.08, height, 0.08]}>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color={index === 3 ? palette.accent : palette.secondary} metalness={0.55} roughness={0.3} />
              </mesh>
            ))}
          </group>
        </group>
      </Float>
      <Sparkles count={18} scale={[3.6, 2.8, 2.2]} size={1.2} speed={reducedMotion ? 0 : 0.22} color={palette.accent} opacity={0.5} />
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
        <span className="billing-finance-fallback-horizon" />
        <span className="billing-finance-fallback-ring billing-finance-fallback-ring-one" />
        <span className="billing-finance-fallback-ring billing-finance-fallback-ring-two" />
        <span className="billing-finance-fallback-core" />
        <span className="billing-finance-fallback-bars">
          <i /><i /><i /><i /><i />
        </span>
      </div>
      <Canvas camera={{ position: [0, 0, 4.8], fov: 34 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }}>
        <FinanceScene palette={palette} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
};
