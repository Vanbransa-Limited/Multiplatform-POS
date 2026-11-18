// Global shared context to eliminate circular dependencies.

/**
 * A module telling the session it is deliberately still working.
 *
 * The idle timer signs out after fifteen minutes without a pointer or key
 * event. The print station is a machine at the counter nobody touches on
 * purpose, so it signed itself out mid-service and took the printer with it.
 * Emitting this on `window` resets that timer; stop emitting and the normal
 * idle timeout resumes.
 */
export const ACTIVITY_EVENT = 'pos-activity';

// The annotation stops TypeScript inferring `null` as the only permitted type
// for these slots when the TSX shell reads them.
/**
 * @type {{
 *   currentUser: any,
 *   currentBranch: any,
 *   currentTenant: any,
 *   activeShift: any,
 *   cloudShiftId: string|null,
 *   syncManager: any,
 *   views: Record<string, any>
 * }}
 */
export const state = {
  currentUser: null,
  currentBranch: null,
  currentTenant: null,
  activeShift: null,
  cloudShiftId: null,
  syncManager: null,
  views: {}
};

export function showNotification(message, type = 'success') {
  const container = document.body;
  if (!container) return;
  
  const notif = document.createElement('div');
  notif.className = `notification-toast ${type}`;
  notif.innerHTML = `
    <span class="toast-text">${message}</span>
  `;
  container.appendChild(notif);
  
  Object.assign(notif.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    padding: '12px 20px',
    fontSize: '12px',
    fontWeight: '600',
    color: type === 'success' ? 'var(--accent-green)' : (type === 'warning' ? 'var(--accent-amber)' : 'var(--accent-rose)'),
    borderColor: type === 'success' ? 'rgba(16, 185, 129, 0.3)' : (type === 'warning' ? 'rgba(245, 158, 11, 0.3)' : 'rgba(244, 63, 94, 0.3)'),
    boxShadow: 'var(--glass-shadow)',
    transform: 'translateY(100px)',
    transition: 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  });
  
  // On a phone the toast sits over the bottom nav, so a tap or sideways swipe
  // clears it at once instead of making staff wait it out.
  notif.setAttribute('role', type === 'error' ? 'alert' : 'status');
  Object.assign(notif.style, { cursor: 'pointer', touchAction: 'pan-y' });
  let gone = false;
  let startX = null;
  const dismiss = () => { if (!gone) { gone = true; notif.remove(); } };
  notif.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    notif.setPointerCapture?.(e.pointerId);
  });
  notif.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    notif.style.transition = 'none';
    notif.style.transform = `translateX(${dx}px)`;
    notif.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 200));
  });
  // A tap and a finished swipe both end here; either way the reader is done with it.
  notif.addEventListener('pointerup', () => { if (startX !== null) dismiss(); });
  notif.addEventListener('pointercancel', () => {
    startX = null;
    Object.assign(notif.style, { transform: 'translateY(0)', opacity: '1' });
  });

  setTimeout(() => { if (startX === null) notif.style.transform = 'translateY(0)'; }, 50);
  setTimeout(() => {
    if (gone) return;
    notif.style.transform = 'translateY(100px)';
    setTimeout(dismiss, 300);
  }, type === 'error' ? 8000 : 4000);
}
