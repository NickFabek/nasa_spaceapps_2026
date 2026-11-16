// Slide navigation for the submission deck. Team details live here so they are easy to change.
const TEAM = { name: 'TEAM NAME', members: ['Nick Fabek'] };

for (const el of document.querySelectorAll('[data-team]')) el.textContent = TEAM.name;
for (const el of document.querySelectorAll('[data-members]')) el.textContent = TEAM.members.join(', ');

const slides = [...document.querySelectorAll('.slide')];
let at = Math.min(slides.length, Math.max(1, parseInt(location.hash.slice(1), 10) || 1)) - 1;
function show(i) {
  at = Math.max(0, Math.min(slides.length - 1, i));
  slides.forEach((s, k) => s.classList.toggle('on', k === at));
  document.getElementById('count').textContent = `${at + 1} / ${slides.length}`;
  history.replaceState(null, '', '#' + (at + 1));
}
document.getElementById('prev').onclick = () => show(at - 1);
document.getElementById('next').onclick = () => show(at + 1);
addEventListener('keydown', (e) => {
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); show(at + 1); }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); show(at - 1); }
});
addEventListener('hashchange', () => show((parseInt(location.hash.slice(1), 10) || 1) - 1));
show(at);

// Slide 2 carries the live mission diagram from the site itself.
import('../js/mission.js').then((m) => m.startMission(document.getElementById('mission'))).catch(() => {});
