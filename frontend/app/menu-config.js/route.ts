export const dynamic = 'force-static';

export function GET() {
  const project = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const region = process.env.NEXT_PUBLIC_FIREBASE_REGION || 'europe-west1';
  const baseUrl = process.env.NEXT_PUBLIC_USE_EMULATORS === '1'
    ? `http://127.0.0.1:5001/${project}/${region}`
    : `https://${region}-${project}.cloudfunctions.net`;
  return new Response(`window.MENU_CONFIG=${JSON.stringify({ baseUrl, tenantId: process.env.NEXT_PUBLIC_TENANT_ID })};`, {
    headers: { 'Content-Type': 'application/javascript' },
  });
}
