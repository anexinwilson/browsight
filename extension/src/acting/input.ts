/**
 * Input simulation. Pages react to the events a real user produces, not to assignments, so filling
 * drives the control's native setter and fires the full input event chain, and clicking fires the
 * whole pointer sequence. Kept apart from the act orchestration so the event details stay readable.
 */
function realmOf(el: Element): typeof globalThis {
  return (el.ownerDocument.defaultView ?? globalThis) as unknown as typeof globalThis;
}

/**
 * Emulate pressing Enter. Key events alone only reach pages that listen for them in JavaScript;
 * a real Enter in a single-line input also performs the browser's default action of submitting the
 * enclosing form, which synthetic events never do. So the events are dispatched as cancelable, and
 * when nothing calls preventDefault the form is submitted through requestSubmit, which is the
 * standard equivalent and still fires submit handlers and validation.
 */
export function dispatchEnter(el: Element): void {
  const realm = realmOf(el);
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
  };
  const notCancelled =
    el.dispatchEvent(new realm.KeyboardEvent("keydown", init)) &&
    el.dispatchEvent(new realm.KeyboardEvent("keypress", init));
  el.dispatchEvent(new realm.KeyboardEvent("keyup", init));
  if (notCancelled) {
    submitOwningForm(el);
  }
}

/** Enter submits from a single-line input only; inside a textarea it inserts a newline. */
function submitOwningForm(el: Element): void {
  if (el.tagName.toLowerCase() !== "input") {
    return;
  }
  const form = (el as HTMLInputElement).form;
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
  }
}

function tagName(el: Element): string {
  return el.tagName.toLowerCase();
}

export function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = tagName(el);
  return tag === "input" || tag === "textarea";
}

export function isSelectControl(el: Element): el is HTMLSelectElement {
  return tagName(el) === "select";
}

export function fillValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const realm = realmOf(el);
  const proto =
    tagName(el) === "textarea"
      ? realm.HTMLTextAreaElement.prototype
      : realm.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  el.dispatchEvent(
    new realm.InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  if (typeof el.setSelectionRange === "function") {
    el.setSelectionRange(value.length, value.length);
  }
  el.dispatchEvent(
    new realm.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  el.dispatchEvent(new realm.Event("change", { bubbles: true, composed: true }));
  el.blur();
}

/** Select an <option> by its value, label, or visible text. */
export function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const realm = realmOf(el);
  const match = Array.from(el.options).find(
    (o) => o.value === value || o.label === value || o.text.trim() === value,
  );
  if (!match) {
    return false;
  }
  el.value = match.value;
  el.dispatchEvent(new realm.Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new realm.Event("change", { bubbles: true, composed: true }));
  return el.value === match.value;
}

/** Replace the text of a contenteditable host, dispatching the input events editors listen for. */
export function fillEditable(el: HTMLElement, value: string): boolean {
  const realm = realmOf(el);
  el.focus();
  el.dispatchEvent(
    new realm.InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  el.textContent = value;
  el.dispatchEvent(
    new realm.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  return (el.textContent ?? "") === value;
}

export function dispatchClick(el: Element): void {
  const realm = realmOf(el);
  const PointerCtor = realm.PointerEvent ?? globalThis.PointerEvent;
  const MouseCtor = realm.MouseEvent ?? globalThis.MouseEvent;
  const rect = (el as HTMLElement).getBoundingClientRect?.();
  const clientX = rect ? rect.left + rect.width / 2 : 0;
  const clientY = rect ? rect.top + rect.height / 2 : 0;
  const mouse: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: realm as unknown as Window,
    button: 0,
    clientX,
    clientY,
  };
  const pointer: PointerEventInit = {
    ...mouse,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  el.dispatchEvent(new PointerCtor("pointerover", pointer));
  el.dispatchEvent(new PointerCtor("pointerenter", pointer));
  el.dispatchEvent(new PointerCtor("pointerdown", pointer));
  el.dispatchEvent(new MouseCtor("mousedown", mouse));
  if (typeof (el as HTMLElement).focus === "function") {
    (el as HTMLElement).focus();
  }
  el.dispatchEvent(new PointerCtor("pointerup", pointer));
  el.dispatchEvent(new MouseCtor("mouseup", mouse));
  const clickable = el as HTMLElement;
  if (typeof clickable.click === "function") {
    clickable.click();
  } else {
    el.dispatchEvent(new MouseCtor("click", mouse));
  }
}

/** Location of the document being acted on, used to notice a navigation the action triggered. */
