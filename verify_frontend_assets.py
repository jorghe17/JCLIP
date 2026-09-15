with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

required_ids = [
    'assistant-fab', 'assistant-menu', 'modal-academia',
    'modal-faq', 'tour-overlay', 'tour-spotlight-box', 'tour-card',
    'academia-modulos-grid', 'academia-progreso-fill', 'academia-progreso-texto',
    'faq-lista-container', 'tour-step-pill', 'tour-card-title', 'tour-card-desc',
    'tour-btn-prev', 'tour-btn-next', 'tour-audio-wave'
]

print("--- Validating index.html DOM IDs ---")
all_found = True
for rid in required_ids:
    found = f'id="{rid}"' in html or f"id='{rid}'" in html
    if not found:
        all_found = False
    print(f"{rid:<26} -> {'[OK]' if found else '[MISSING]'}")

print(f"\nDOM Validation Result: {'ALL IDS PRESENT' if all_found else 'SOME IDS MISSING'}")

with open('styles.css', 'r', encoding='utf-8') as f:
    css = f.read()

required_classes = [
    'assistant-fab', 'assistant-menu', 'tour-overlay',
    'tour-spotlight-box', 'tour-card', 'audio-wave-container',
    'academia-grid', 'academia-card', 'faq-item-card'
]

print("\n--- Validating styles.css Classes ---")
css_ok = True
for cls in required_classes:
    found = f".{cls}" in css
    if not found:
        css_ok = False
    print(f".{cls:<25} -> {'[OK]' if found else '[MISSING]'}")

print(f"\nCSS Validation Result: {'ALL STYLES PRESENT' if css_ok else 'SOME STYLES MISSING'}")
