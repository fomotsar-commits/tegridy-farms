import { Outlet } from 'react-router-dom';
import { TopNav } from './TopNav';
import { BottomNav } from './BottomNav';
import { Background } from './Background';
import { Footer } from './Footer';
import { Toaster } from 'sonner';

export function AppLayout() {
  return (
    <>
      <Background />
      <TopNav />

      <div className="min-h-screen relative z-10 pt-14 pb-16 md:pb-0">
        <main>
          <Outlet />
        </main>
        <Footer />
      </div>

      <BottomNav />

      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          style: {
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            fontFamily: "'Inter', sans-serif",
          },
        }}
      />
    </>
  );
}
