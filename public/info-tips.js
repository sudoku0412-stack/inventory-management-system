// A small "i" button next to each field label. Hover, focus or tap shows a one-line explanation; Escape or a tap
// elsewhere closes it. The tip text lives here so it can be reviewed in one place. Tips avoid the word "medicine"
// so they read correctly in General goods Shops too.
export const FIELD_TIPS = [
  ['#addMedicineForm [name=name]', 'The name as printed on the package.'],
  ['#addMedicineForm [name=strength]', 'How strong one unit is, for example 500 mg. Leave it empty if the package does not say.'],
  ['#addMedicineForm [name=form]', 'The kind of item, for example Tablets or Liquid. Owners can change this list in Profile.'],
  ['#addMedicineForm [name=quantity]', 'How many units you have right now.'],
  ['#expiryDate', 'The use-by date printed on the package. Tick the box below if there is none.'],
  ['#addMedicineForm [name=unit]', 'What one unit is counted as, for example bottle or pack.'],
  ['#addMedicineForm [name=low_stock_threshold]', 'You get a low-stock alert when the quantity falls to this number or less.'],
  ['#addMedicineForm [name=location]', 'Where you keep it. Owners can change this list in Profile.'],
  ['#addMedicineForm [name=notes]', 'Anything worth remembering, such as dosage or who it is for.'],
  ['#displayName', 'Your name, shown in the greeting and on your avatar.'],
  ['#householdName', 'The Shop’s name, shown in the sidebar and to everyone who shares it.'],
  ['#shopTypeSelect', 'Medicine or General goods. It changes wording and default lists, never your saved items.'],
  ['#defaultStorageLocation', 'The location pre-selected when you add a new item.'],
  ['#householdInviteEmail', 'The email address this person signs in with.'],
  ['#householdInviteRole', 'Members update stock. Owners also manage people and Shop settings.'],
  ['#createShopName', 'The name of the new Shop. You can change it later in Profile.'],
  ['#createShopType', 'Medicine or General goods. It sets the wording and default lists.'],
  ['#createDisplayName', 'Your name inside the new Shop.']
];

const GAP = 8, EDGE = 8;

/** Fixed-position placement: below the icon, nudged to stay on screen, flipped above when there is no room below. */
export function placeTip(anchor, tip, viewport) {
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - tip.width - EDGE));
  const below = anchor.bottom + GAP;
  const top = below + tip.height > viewport.height - EDGE && anchor.top - GAP - tip.height >= EDGE ? anchor.top - GAP - tip.height : below;
  return { left: Math.round(left), top: Math.round(top) };
}

export function anchorFor(control) {
  const byFor = control.id ? control.ownerDocument.querySelector(`label[for="${control.id}"]`) : null;
  return byFor || control.closest('.form-field')?.querySelector(':scope > span, :scope > label') || null;
}

export function bindInfoTips({ document, tips = FIELD_TIPS, getViewport = () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }) }) {
  let open = null;
  let serial = 0;

  function hide() {
    if (!open) return;
    open.button.setAttribute('aria-expanded', 'false');
    open.button.removeAttribute('aria-describedby');
    open.node.remove();
    open = null;
  }

  function show(button, text) {
    if (open?.button === button) return;
    hide();
    const node = document.createElement('div');
    node.className = 'info-tip-text';
    node.setAttribute('role', 'tooltip');
    node.id = `infoTip${serial += 1}`;
    node.textContent = text;
    (button.closest('dialog') || document.body).append(node);
    // A transformed ancestor (the mobile dialog) becomes the containing block of a fixed element, so measure where
    // left:0 / top:0 really lands and offset by that.
    node.style.left = '0px'; node.style.top = '0px';
    const anchor = button.getBoundingClientRect(), size = node.getBoundingClientRect();
    const spot = placeTip(anchor, { width: size.width, height: size.height }, getViewport());
    node.style.left = `${spot.left - size.left}px`; node.style.top = `${spot.top - size.top}px`;
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-describedby', node.id);
    open = { button, node };
  }

  let count = 0;
  for (const [selector, text] of tips) {
    const control = document.querySelector(selector);
    const anchor = control && anchorFor(control);
    if (!anchor || anchor.querySelector('.info-tip')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'info-tip';
    button.textContent = 'i';
    button.dataset.tip = text;
    button.setAttribute('aria-label', 'What is this?');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('mouseenter', () => show(button, button.dataset.tip));
    button.addEventListener('mouseleave', () => { if (!(open?.button === button && open.pinned) && document.activeElement !== button) hide(); });
    button.addEventListener('focus', () => show(button, button.dataset.tip));
    button.addEventListener('blur', hide);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (open?.button === button && open.pinned) { hide(); return; }
      show(button, button.dataset.tip);
      open.pinned = true;
    });
    anchor.append(button);
    count += 1;
  }

  document.addEventListener('keydown', event => { if (event.key === 'Escape' && open) { event.stopPropagation(); hide(); } }, true);
  document.addEventListener('click', event => { if (open && !event.target.closest?.('.info-tip')) hide(); });
  document.addEventListener('scroll', hide, true);

  return { hide, count };
}
