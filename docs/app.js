// Theme toggle (remembered per browser), copy buttons on code blocks, curl / Node tabs. No dependencies.
(() => {
  const root = document.documentElement, key = 'apk-lab-docs-theme';
  try { const saved = localStorage.getItem(key); if (saved === 'light' || saved === 'dark') root.dataset.theme = saved; } catch { /* storage blocked */ }
  const button = document.querySelector('button.theme');
  const label = () => { const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; if (button) button.textContent = dark ? '☀︎ Claro' : '☾ Escuro'; return dark; };
  label();
  button?.addEventListener('click', () => { const next = label() ? 'light' : 'dark'; root.dataset.theme = next; try { localStorage.setItem(key, next); } catch { /* ignore */ } label(); });
  for (const pre of document.querySelectorAll('pre')) {
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy'; copy.textContent = 'Copiar';
    copy.addEventListener('click', async () => {
      const text = pre.querySelector('code')?.innerText ?? pre.innerText;
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copiado'; }
      catch { const range = document.createRange(); range.selectNodeContents(pre.querySelector('code') ?? pre); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = 'Selecionado'; }
      setTimeout(() => { copy.textContent = 'Copiar'; }, 1500);
    });
    pre.append(copy);
  }
  for (const tabs of document.querySelectorAll('.tabs')) {
    const panels = [...tabs.querySelectorAll(':scope > .panel')], list = document.createElement('div'); list.className = 'tablist'; list.setAttribute('role', 'tablist');
    panels.forEach((panel, index) => {
      const tab = document.createElement('button'); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.textContent = panel.dataset.label; tab.setAttribute('aria-selected', String(index === 0)); panel.hidden = index !== 0;
      tab.addEventListener('click', () => { for (const other of list.children) other.setAttribute('aria-selected', String(other === tab)); panels.forEach(p => { p.hidden = p !== panel; }); });
      list.append(tab);
    });
    tabs.prepend(list);
  }
})();
