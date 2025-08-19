// Smart hover tooltip that can render dynamic content (including canvas)
let currentCard = null;
let currentAnchor = null;

export function attachHovercard(container, { selector, render }) {
  container.addEventListener('mouseenter', onEnter, true);
  container.addEventListener('mouseleave', onLeave, true);
  container.addEventListener('focusin', onEnter, true);
  container.addEventListener('focusout', onLeave, true);

  function onEnter(ev) {
    const el = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (!el) return;
    show(el, render);
  }
  function onLeave(ev) {
    const el = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (!el) return;
    hide(el);
  }
}

function show(anchor, render) {
  hide();
  currentAnchor = anchor;
  const card = document.createElement('div');
  card.className = 'hovercard';
  card.setAttribute('role', 'tooltip');
  const content = render(anchor);
  if (content) card.appendChild(content);
  document.body.appendChild(card);
  position(anchor, card);
  currentCard = card;

  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);
  function onScroll() { if (currentCard && currentAnchor) position(currentAnchor, currentCard); }
}

function hide() {
  if (currentCard && currentCard.parentNode) currentCard.parentNode.removeChild(currentCard);
  currentCard = null; currentAnchor = null;
  window.removeEventListener('scroll', null, true);
  window.removeEventListener('resize', null, true);
}

function position(anchor, card) {
  const r = anchor.getBoundingClientRect();
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = r.left + (r.width/2) - cw/2;
  let y = r.bottom + 8;

  // keep in viewport
  x = Math.max(8, Math.min(x, window.innerWidth - cw - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - ch - 8));

  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
}
