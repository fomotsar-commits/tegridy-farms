import { motion } from 'framer-motion';

export function PageTransition({ children }: { children: React.ReactNode }) {
  const exitX = (Math.random() - 0.5) * 20;
  const exitSkew = (Math.random() - 0.5) * 4;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{
        opacity: 0,
        filter:
          'drop-shadow(5px 0 0 rgba(255,0,0,0.5)) drop-shadow(-5px 0 0 rgba(0,0,255,0.5))',
        x: exitX,
        skewX: exitSkew,
        transition: { duration: 0.4, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        duration: 0.5,
        ease: 'easeOut',
      }}
    >
      {children}
    </motion.div>
  );
}
