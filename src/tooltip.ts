import { MarkdownRenderer, TFile } from 'obsidian';

import { t } from './lang/helpers';
import ReferenceList from './main';
import clip from 'text-clipper';
import type { TooltipCiteContext } from './bib/bibManager';

export class TooltipManager {
  plugin: ReferenceList;
  tooltip: HTMLDivElement;
  isHoveringTooltip = false;
  isScrollBound = false;
  activeEditorKey: string = null;

  constructor(plugin: ReferenceList) {
    this.plugin = plugin;
    plugin.register(() => this.hideTooltip());
  }

  private getClosestAnchorBestHref(el: HTMLElement): string | null {
    const a = el.closest('a');
    if (!a) return null;
    const dataHref = a.getAttribute('data-href')?.trim();
    const href = a.getAttribute('href')?.trim();
    const best = href && href.includes('#') ? href : dataHref || href;
    return best?.trim() || null;
  }

  private extractBlockIdFromTarget(target: string | null): string | null {
    if (!target) return null;
    const m = /#\^([^?#\s]+)/.exec(target);
    return m?.[1] || null;
  }

  private async getBlockText(file: TFile, blockId: string): Promise<string | null> {
    try {
      const cache = app.metadataCache.getFileCache(file) as any;
      const block = cache?.blocks?.[blockId];
      const content = await app.vault.cachedRead(file);

      if (block?.position?.start?.line !== undefined && block?.position?.end?.line !== undefined) {
        const lines = content.split(/\r?\n/);
        const startLine = Math.max(0, block.position.start.line);
        const endLine = Math.min(lines.length - 1, block.position.end.line);
        const slice = lines.slice(startLine, endLine + 1).join('\n');
        return slice.replace(new RegExp(`\\s*\\^${blockId}\\b`, 'g'), '').trim() || null;
      }

      // Fallback: try to find the block id on a line
      const re = new RegExp(`\\^${blockId}\\b`);
      const line = content.split(/\r?\n/).find((l) => re.test(l));
      return line?.replace(re, '').trim() || null;
    } catch {
      return null;
    }
  }

  private extractPageFromBlockText(blockText: string | null): string | undefined {
    if (!blockText) return undefined;

    const explicit = /\bpage\s*=\s*([^\s&]+)/i.exec(blockText);
    if (explicit?.[1]) return explicit[1];

    const implicit = /\bp\.?\s*([ivxlcdm]+|\d+)\b/i.exec(blockText);
    if (implicit?.[1]) return implicit[1];

    return undefined;
  }

  private extractZoteroOpenPdfUrlFromBlockText(
    blockText: string | null,
    blockId: string,
    fallbackPage?: string
  ): string | undefined {
    if (!blockText) return undefined;

    // Prefer an explicit zotero://open-pdf/... link if present in the block.
    const raw = /zotero:\/\/open-pdf\/[\w\/-]+(?:\?[^\s)"']*)?/i.exec(blockText)?.[0];
    if (raw) {
      const [base, query] = raw.split('?');
      const params = new URLSearchParams(query || '');
      if (fallbackPage && !params.get('page')) params.set('page', fallbackPage);
      params.set('annotation', blockId);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }

    // Fallback: try to derive Zotero item key from a Storage path.
    const storageKey = /\/Storage\/([A-Z0-9]{8})\//.exec(blockText)?.[1];
    if (storageKey) {
      const params = new URLSearchParams();
      if (fallbackPage) params.set('page', fallbackPage);
      params.set('annotation', blockId);
      return `zotero://open-pdf/library/items/${storageKey}?${params.toString()}`;
    }

    return undefined;
  }

  private extractFirstPdfLinkFromBlockText(blockText: string | null): string | null {
    if (!blockText) return null;

    const candidates = [
      /!\[[^\]]*\]\(([^)]+)\)/.exec(blockText)?.[1],
      /\[[^\]]*\]\(([^)]+)\)/.exec(blockText)?.[1],
    ].filter(Boolean) as string[];

    for (const c of candidates) {
      const trimmed = c.trim();
      const noParams = trimmed.split(/[?#]/)[0];
      if (!noParams.toLowerCase().endsWith('.pdf')) continue;
      try {
        return decodeURI(trimmed);
      } catch {
        return trimmed;
      }
    }

    return null;
  }

  async showTooltip(el: HTMLSpanElement) {
    if (this.tooltip) {
      this.hideTooltip();
    }

    if (!el.dataset.source) return;

    const file = app.vault.getAbstractFileByPath(el.dataset.source);
    if (!(file instanceof TFile)) {
      return;
    }

    el.win.clearTimeout(this.previewDBTimer);
    el.win.clearTimeout(this.previewDBTimerClose);

    const keys = el.dataset.citekey.split('|');

    let pdfLinkOverride = (() => {
      if (el.dataset.pwcPdfLink) {
        return el.dataset.pwcPdfLink;
      }

      const best = this.getClosestAnchorBestHref(el);
      if (!best) return null;
      const trimmed = best.trim();
      const noParams = trimmed.split(/[?#]/)[0];
      if (!noParams.toLowerCase().endsWith('.pdf')) return null;
      try {
        return decodeURI(trimmed);
      } catch {
        return trimmed;
      }
    })();

    const mdLinkTarget = (() => {
      const fromDataset = el.dataset.pwcMdLink?.trim();
      if (fromDataset) return fromDataset;

      const best = this.getClosestAnchorBestHref(el);
      if (!best) return null;
      const trimmed = best.trim();
      const noParams = trimmed.split(/[?#]/)[0];
      if (!noParams.toLowerCase().endsWith('.md')) return null;
      return trimmed;
    })();

    const blockId =
      el.dataset.pwcBlockId?.trim() || this.extractBlockIdFromTarget(mdLinkTarget);

    const shouldUseAnnotationContext =
      !!blockId &&
      keys.length === 1 &&
      !!mdLinkTarget &&
      mdLinkTarget.toLowerCase().includes(keys[0].toLowerCase());

    let blockText: string | null = null;
    let annotationPage: string | undefined = undefined;
    let annotationOpenUrl: string | undefined = undefined;
    let pdfLinkSourcePath: string | undefined = undefined;

    if (shouldUseAnnotationContext) {
      const blockIdStr = blockId as string;
      const mdLinkPath = mdLinkTarget.split(/[?#]/)[0].split('#')[0];
      let linkDest =
        app.metadataCache.getFirstLinkpathDest(mdLinkPath, file.path) ||
        app.vault.getAbstractFileByPath(mdLinkPath);

      if (!(linkDest instanceof TFile) && mdLinkPath.toLowerCase().endsWith('.md')) {
        const withoutExt = mdLinkPath.slice(0, -3);
        linkDest =
          app.metadataCache.getFirstLinkpathDest(withoutExt, file.path) ||
          app.vault.getAbstractFileByPath(withoutExt);
      }

      if (linkDest instanceof TFile) {
        blockText = await this.getBlockText(linkDest, blockIdStr);
        annotationPage = this.extractPageFromBlockText(blockText);
        annotationOpenUrl = this.extractZoteroOpenPdfUrlFromBlockText(
          blockText,
          blockIdStr,
          annotationPage
        );

        const blockPdf = this.extractFirstPdfLinkFromBlockText(blockText);
        if (blockPdf && !pdfLinkOverride) {
          pdfLinkOverride = blockPdf;
          pdfLinkSourcePath = linkDest.path;
        }
      }
    }

    const tooltipContext: TooltipCiteContext = {
      pdfLinkOverride,
      pdfLinkSourcePath,
      ...(shouldUseAnnotationContext
        ? {
            zoteroAnnotation: {
              blockId: blockId as string,
              page: annotationPage,
              openUrl: annotationOpenUrl,
            },
          }
        : {}),
    };

    let content: DocumentFragment | HTMLElement = null;

    if (el.dataset.noteIndex) {
      content = createDiv();
      const html = this.plugin.bibManager.getNoteForNoteIndex(
        file as TFile,
        el.dataset.noteIndex
      );
      content.append(...html);
    } else {
      for (const key of keys) {
        const html = this.plugin.bibManager.getBibForCiteKey(
          file as TFile,
          key,
          tooltipContext
        ) as HTMLElement;

        if (html) {
          if (!content) content = createFragment();
          if (keys.length > 1) {
            let target = html.find('.csl-right-inline');
            if (!target) target = html.find('.csl-entry');
            if (!target) target = html;
            const inner = target.innerHTML;
            const clipped = clip(inner, 100, { html: true });
            target.innerHTML = clipped;
          }
          content.append(html);
        }
      }
    }

    const modClasses = this.plugin.settings.hideLinks ? ' collapsed-links' : '';
    const tooltip = (this.tooltip = el.doc.body.createDiv({
      cls: `pwc-tooltip${modClasses}`,
    }));

    const rect = el.getBoundingClientRect();

    if (rect.x === 0 && rect.y === 0) {
      return this.hideTooltip();
    }

    if (this.plugin.settings.hideLinks) {
      tooltip.addClass('collapsed-links');
    }

    if (blockText) {
      const block = tooltip.createDiv({ cls: 'pwc-block-preview' });
      await MarkdownRenderer.renderMarkdown(blockText, block, file.path, this.plugin);
    }

    if (content) {
      tooltip.append(content);
    } else {
      tooltip.addClass('is-missing');
      tooltip.createEl('em', {
        text: t('No citation found for ') + el.dataset.citekey,
      });
    }

    tooltip.addEventListener('pointerover', () => {
      this.isHoveringTooltip = true;
    });
    tooltip.addEventListener('pointerout', () => {
      this.isHoveringTooltip = false;
    });
    tooltip.addEventListener('click', (evt) => {
      if (evt.targetNode.instanceOf(HTMLElement)) {
        if (
          evt.targetNode.tagName === 'A' ||
          evt.targetNode.hasClass('clickable-icon')
        ) {
          this.hideTooltip();
        }
      }
    });

    el.win.setTimeout(() => {
      const viewport = el.win.visualViewport;
      const divRect = tooltip.getBoundingClientRect();

      tooltip.style.left =
        rect.x + divRect.width + 10 > viewport.width
          ? `${rect.x - (rect.x + divRect.width + 10 - viewport.width)}px`
          : `${rect.x}px`;
      tooltip.style.top =
        rect.bottom + divRect.height + 10 > viewport.height
          ? `${rect.y - divRect.height - 5}px`
          : `${rect.bottom + 5}px`;
    });

    this.isScrollBound = true;
    this.boundScroll = () => {
      if (this.isScrollBound) {
        this.hideTooltip();
      }
    };
    el.win.addEventListener('scroll', this.boundScroll, { capture: true });
  }

  boundScroll: () => void;

  hideTooltip() {
    this.isHoveringTooltip = false;
    this.isScrollBound = false;
    this.activeEditorKey = null;
    this.tooltip?.win.removeEventListener('scroll', this.boundScroll);
    this.tooltip?.remove();
    this.tooltip = null;
    this.boundScroll = null;
  }

  previewDBTimer = 0;
  previewDBTimerClose = 0;
  bindPreviewTooltipHandler(el: HTMLElement) {
    el.addEventListener('pointerover', (evt) => {
      evt.view.clearTimeout(this.previewDBTimer);
      evt.view.clearTimeout(this.previewDBTimerClose);
      this.previewDBTimer = evt.view.setTimeout(() => {
        this.showTooltip(el);
      }, this.plugin.settings.tooltipDelay);
    });

    el.addEventListener('pointerout', (evt) => {
      evt.view.clearTimeout(this.previewDBTimer);
      if (!this.tooltip) return;
      this.previewDBTimerClose = evt.view.setTimeout(() => {
        if (this.isHoveringTooltip) {
          this.handleToolipHover();
        } else {
          this.hideTooltip();
        }
      }, 150);
    });
  }

  handleToolipHover() {
    if (this.isHoveringTooltip) {
      const { tooltip } = this;
      const outhandler = (evt: PointerEvent) => {
        evt.view.clearTimeout(this.previewDBTimerClose);
        this.previewDBTimerClose = evt.view.setTimeout(() => {
          tooltip.removeEventListener('pointerout', outhandler);
          tooltip.removeEventListener('pointerenter', outhandler);
          if (this.isHoveringTooltip) {
            this.handleToolipHover();
          } else {
            this.hideTooltip();
          }
        }, 150);
      };
      const enterHandler = (evt: PointerEvent) => {
        evt.view.clearTimeout(this.previewDBTimerClose);
      };
      tooltip.addEventListener('pointerout', outhandler);
      tooltip.addEventListener('pointerenter', enterHandler);
    }
  }

  getEditorTooltipHandler() {
    let dbOverTimer = 0;
    let dbOutTimer = 0;
    let isClosing = false;

    return {
      scroll: (evt: UIEvent) => {
        if (this.activeEditorKey) {
          evt.view?.clearTimeout(dbOutTimer);
          evt.view?.clearTimeout(dbOverTimer);
          this.activeEditorKey = null;
        }
      },
      pointerover: (evt: PointerEvent) => {
        const target = evt.targetNode;
        if (target.instanceOf(HTMLElement)) {
          const citekey = target.dataset.citekey;
          if (citekey) {
            evt.view.clearTimeout(dbOutTimer);
            isClosing = false;
            if (citekey !== this.activeEditorKey) {
              if (this.activeEditorKey) {
                this.hideTooltip();
                this.activeEditorKey = null;
              }
              evt.view.clearTimeout(dbOverTimer);
              dbOverTimer = evt.view.setTimeout(() => {
                this.showTooltip(target);
                this.activeEditorKey = citekey;
              }, this.plugin.settings.tooltipDelay);
            }
            return;
          }
        }
        evt.view.clearTimeout(dbOverTimer);
        if (this.activeEditorKey && !isClosing) {
          if (!this.tooltip) return;
          isClosing = true;
          dbOutTimer = evt.view.setTimeout(() => {
            if (this.isHoveringTooltip) {
              isClosing = false;
            } else {
              this.hideTooltip();
              this.activeEditorKey = null;
              isClosing = false;
            }
          }, 150);
        }
      },
    };
  }
}
