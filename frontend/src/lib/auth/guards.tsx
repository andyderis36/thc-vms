'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CloudOff } from 'lucide-react';
import { consumeSessionExpiredFlag, useSession } from '@/lib/auth/session';
import { getLoginRedirect } from '@/lib/auth/capabilities';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Role } from '@/lib/api/types';

/**
 * Ranah perlindungan client-side (JWT ada di `localStorage`, tak terbaca
 * server — tidak ada `proxy.ts`/`middleware.ts` by design).
 *
 * Aturan kritis: guard tidak pernah merender `children` terproteksi walau
 * sesaat sebelum redirect. Keputusan redirect dihitung sinkron saat render,
 * navigasi (`router.replace`) dijalankan di `useEffect`.
 */

/**
 * Pilih tujuan login: sesi kedaluwarsa -> `/login?expired=1` (toast sekali),
 * belum pernah login -> `/login` polos (tanpa toast). Flag sekali-pakai
 * dikonsumsi (dihapus) di sini agar toast tidak berulang.
 */
function resolveLoginTarget(): string {
  return consumeSessionExpiredFlag() ? '/login?expired=1' : '/login';
}

function LoadingPlaceholder(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[40vh] items-center justify-center text-sm text-neutral-500"
    >
      Memuat…
    </div>
  );
}

/**
 * Hidrasi `/auth/me` gagal karena gangguan sementara (jaringan/429/5xx).
 * Sesi BELUM berakhir dan token masih tersimpan, jadi JANGAN redirect ke
 * `/login` — cukup beri tombol coba lagi. `refresh()` yang menentukan nasib
 * berikutnya: sukses -> authenticated, 401 -> guard mengalihkan ke login.
 */
export function SessionRecoveryPlaceholder({
  onRetry,
}: {
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <EmptyState
        icon={<CloudOff className="size-8" aria-hidden="true" />}
        title="Sesi belum dapat diverifikasi"
        description="Koneksi ke server sedang bermasalah. Sesi Anda masih tersimpan — periksa jaringan lalu coba lagi."
        action={
          <Button variant="secondary" onClick={onRetry}>
            Coba Lagi
          </Button>
        }
      />
    </div>
  );
}

/**
 * Wajib login. Tanpa sesi -> `/login` polos, sesi kedaluwarsa ->
 * `/login?expired=1` (toast sekali di layar login); render `null`.
 * Dipakai di `/dashboard`, `/visits/new`, `/visits/[id]`, `/gate`.
 */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { status, refresh } = useSession();
  const router = useRouter();

  const unauthenticated = status === 'unauthenticated';

  useEffect(() => {
    if (unauthenticated) {
      // Bedakan sesi kedaluwarsa (?expired=1 -> toast sekali di /login)
      // vs belum pernah login (/login polos tanpa toast).
      router.replace(resolveLoginTarget());
    }
  }, [unauthenticated, router]);

  if (status === 'loading') {
    return <LoadingPlaceholder />;
  }
  if (status === 'error') {
    return <SessionRecoveryPlaceholder onRetry={() => void refresh()} />;
  }
  if (unauthenticated) {
    return null;
  }
  return <>{children}</>;
}

interface RequireRoleProps {
  allow: readonly Role[];
  children: ReactNode;
}

/**
 * Wajib login + wajib peran. Peran di luar `allow` diarahkan ke home route
 * perannya (`getLoginRedirect` — satu sumber kebenaran) dan render `null`.
 * Contoh: Vendor/Mitra yang membuka `/gate` dipulangkan ke `/dashboard`.
 */
export function RequireRole({ allow, children }: RequireRoleProps): React.JSX.Element | null {
  const { user, status, refresh } = useSession();
  const router = useRouter();

  const unauthenticated = status === 'unauthenticated';
  const role: Role | null = user?.role ?? null;
  const denied =
    status === 'authenticated' && role !== null && !allow.includes(role);
  const home: string = role !== null ? getLoginRedirect(role) : '/dashboard';

  useEffect(() => {
    if (unauthenticated) {
      // Sama seperti RequireAuth: expired -> `?expired=1`, baru -> polos.
      router.replace(resolveLoginTarget());
    } else if (denied) {
      router.replace(home);
    }
  }, [unauthenticated, denied, home, router]);

  if (status === 'loading') {
    return <LoadingPlaceholder />;
  }
  if (status === 'error') {
    return <SessionRecoveryPlaceholder onRetry={() => void refresh()} />;
  }
  if (unauthenticated) {
    return null;
  }
  if (user === null) {
    return null;
  }
  if (denied) {
    return null;
  }
  return <>{children}</>;
}

/**
 * Hook kenyamanan untuk menyembunyikan kontrol per-peran (mis. sembunyikan
 * Approve/Reject dari Vendor/Mitra). Kembalikan peran bila sesi terautentikasi dan
 * peran termasuk `allow`, selain itu `null`. Tidak menavigasi.
 */
export function useRequireRole(allow: readonly Role[]): Role | null {
  const { user, status } = useSession();
  if (status !== 'authenticated' || user === null) {
    return null;
  }
  return allow.includes(user.role) ? user.role : null;
}
