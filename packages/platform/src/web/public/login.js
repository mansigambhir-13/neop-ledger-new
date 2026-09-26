// Sign-in: the token goes to the BFF once; it answers with an httpOnly cookie.
const f = document.getElementById('f');
const e = document.getElementById('e');
f.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  e.classList.add('hidden');
  const token = document.getElementById('t').value.trim();
  const r = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-neos-web': '1' }, body: JSON.stringify({ token }) }).catch(() => null);
  if (r && r.ok) return location.replace('/');
  const body = r ? await r.json().catch(() => ({})) : {};
  e.textContent = body.error?.message ?? 'Could not reach the server.';
  e.classList.remove('hidden');
});
