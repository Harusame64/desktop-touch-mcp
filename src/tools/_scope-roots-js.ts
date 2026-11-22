/**
 * _scope-roots-js.ts — what a `scope` CSS selector limits a search to, shared by every page script that takes one
 * (internal #420): every element the selector matches, not only the first. win2 on #1022: `scope:"#s1, #s2"` acted as
 * if only #s1 were in scope, because the scripts read `document.querySelector(scope)`.
 */
/**
 * `__scopeRoots(sel)`: the elements a search is limited to, in document order. With no scope (`null`), the document.
 * A match inside another match is left out: its elements are already searched through the outer one, and a search
 * that went through both would list them twice. An empty array when the selector matches nothing; an invalid selector
 * throws, as `querySelector` did.
 *
 * `__qsaIn(roots, q)`: `querySelectorAll(q)` over each root in turn, which is document order because the roots are
 * disjoint and in document order. Like `root.querySelectorAll`, a root itself is not one of its own results.
 *
 * Both call the DOM through its prototypes, so a page that shadows a member on a form cannot change them (each falls
 * back to the node's own member where there is no DOM, as SAFE_DOM_JS does).
 */
export const SCOPE_ROOTS_JS = `
  function __scopeRoots(sel) {
    if (sel === null) return [document];
    const docQsa = typeof Document !== 'undefined' ? Document.prototype.querySelectorAll : document.querySelectorAll;
    const found = Array.prototype.slice.call(docQsa.call(document, sel));
    const inSet = new Set(found);
    const parentGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get : null;
    const parentOf = function(n) { return parentGet ? parentGet.call(n) : n.parentElement; };
    return found.filter(function(el) {
      for (let a = parentOf(el); a; a = parentOf(a)) if (inSet.has(a)) return false;
      return true;
    });
  }
  function __qsaIn(roots, q) {
    const out = [];
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      const qsa = r === document
        ? (typeof Document !== 'undefined' ? Document.prototype.querySelectorAll : r.querySelectorAll)
        : (typeof Element !== 'undefined' ? Element.prototype.querySelectorAll : r.querySelectorAll);
      const list = qsa.call(r, q);
      for (let j = 0; j < list.length; j++) out.push(list[j]);
    }
    return out;
  }
`;
