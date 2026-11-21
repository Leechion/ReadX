import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { WorkspaceIcon } from './WorkspaceIcon';

interface ReaderTool {
  id: string;
  label: string;
  title?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  radio?: boolean;
  onSelect: () => void;
}

export interface ReaderToolGroup {
  id: 'reading' | 'document' | 'assistant';
  label: string;
  summary?: string;
  sections: readonly { label?: string; tools: ReaderTool[] }[];
}

function menuButtons(menu: HTMLDivElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
}

export function ReaderToolbarMenus({ groups }: { groups: ReaderToolGroup[] }) {
  const [active, setActive] = useState<ReaderToolGroup['id'] | null>(null);
  const root = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const openAtEnd = useRef(false);
  const id = useId();

  useLayoutEffect(() => {
    if (!active) return;
    const buttons = menuButtons(menu.current);
    (openAtEnd.current ? buttons.at(-1) : buttons[0])?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setActive(null);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [active]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = menuButtons(menu.current);
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1)
      : buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
  };

  return <nav className="reader-toolbar-actions" aria-label="阅读工具" ref={root}>
    {groups.map(group => {
      const open = active === group.id;
      const triggerId = `${id}-${group.id}`;
      const menuId = `${triggerId}-menu`;
      const focusTrigger = () => document.getElementById(triggerId)?.focus({ preventScroll: true });
      return <div
        className="reader-tool-category"
        data-keep-reader-selection={group.id === 'assistant' || undefined}
        key={group.id}
        onBlur={event => {
          if (!open) return;
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setActive(current => current === group.id ? null : current);
          }
        }}
        onKeyDown={event => {
          if (!open || event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          focusTrigger();
          setActive(null);
        }}
      >
        <button
          id={triggerId}
          type="button"
          className="reader-tool-trigger"
          aria-label={group.summary ? `${group.label}（${group.summary}）` : group.label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={group.sections.every(section => section.tools.every(tool => tool.disabled))}
          onClick={() => {
            openAtEnd.current = false;
            setActive(open ? null : group.id);
          }}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            openAtEnd.current = event.key === 'ArrowUp';
            if (open) {
              const buttons = menuButtons(menu.current);
              (openAtEnd.current ? buttons.at(-1) : buttons[0])?.focus();
            } else setActive(group.id);
          }}
        >
          <span>{group.label}</span>
          {group.summary && <small aria-hidden="true">{group.summary}</small>}
          <WorkspaceIcon name="chevron" size={15} />
        </button>
        {open && <div id={menuId} className="reader-tool-menu" role="menu" aria-labelledby={triggerId} ref={menu} onKeyDown={event => {
          if (event.key === 'Tab') {
            focusTrigger();
            setActive(null);
          } else moveFocus(event);
        }}>
          {group.sections.map((section, index) => <div className="reader-tool-section" role="group" aria-label={section.label} key={section.label ?? index}>
            {section.label && <div className="reader-tool-section-label" aria-hidden="true">{section.label}</div>}
            {section.tools.map(tool => <button
              type="button"
              role={tool.radio ? 'menuitemradio' : tool.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={tool.checked}
              title={tool.title}
              disabled={tool.disabled}
              tabIndex={-1}
              className="reader-tool-item"
              key={tool.id}
              onClick={() => {
                focusTrigger();
                setActive(null);
                tool.onSelect();
              }}
            >
              <span>{tool.label}</span>
              {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
              {tool.checked && <WorkspaceIcon name="check" size={15} />}
            </button>)}
          </div>)}
        </div>}
      </div>;
    })}
  </nav>;
}
