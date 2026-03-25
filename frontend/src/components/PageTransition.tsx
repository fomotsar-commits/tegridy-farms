import { motion } from 'framer-motion';

export function PageTransition({ children }: { children: React.ReactNode }) {
  const exitX = (Math.random() - 0.5) * 30;
  const exitSkew = (Math.random() - 0.5) * 5;

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{
        opacity: 0,
        filter:
          'drop-shadow(6px 0 0 rgba(255,0,0,0.5)) drop-shadow(-6px 0 0 rgba(0,0,255,0.5))',
        x: exitX,
        skewX: exitSkew,
        transition: { duration: 0.7, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        duration: 0.8,
        ease: [0.25, 0.1, 0.25, 1],
      }}
    >
      {children}
    </motion.div>
  );
}
