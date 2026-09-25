# Design System – THC Visitor Management

## 1. Brand Identity

- Nama: THC Visitor Management
- Logo: teks "THC" bold + icon building
- Tone: profesional, bersih, terpercaya, industrial
- Bahasa: Indonesia (default)

## 2. Color Palette

### Primary

- Primary Main: `#DE1B1B` (merah THC)
- Primary Mid: `#B91616`
- Primary Soft: `#FEE2E2`
- Primary Text on Primary: `#FFFFFF`

### Neutral

- Background Page: `#F5F7FA`
- Background Card: `#FFFFFF`
- Border Light: `#E5E7EB`
- Border Mid: `#D1D5DB`
- Text Primary: `#1A1A1A`
- Text Secondary: `#6B7280`
- Text Muted: `#9CA3AF`

### Semantic

- Success: `#166534` (text) / `#DCFCE7` (bg)
- Warning: `#92400E` (text) / `#FEF3C7` (bg)
- Error: `#991B1B` (text) / `#FEE2E2` (bg)
- Info: `#1E40AF` (text) / `#DBEAFE` (bg)

### Status Badge Mapping

| Status | Background | Text |
|--------|------------|------|
| requested | `#DBEAFE` | `#1E40AF` |
| approved | `#DCFCE7` | `#166534` |
| visiting | `#DBEAFE` | `#1E40AF` |
| completed | `#DCFCE7` | `#166534` |
| not_visit | `#FEE2E2` | `#991B1B` |
| rejected | `#FEE2E2` | `#991B1B` |
| cancelled | `#F3F4F6` | `#6B7280` |
| rescheduled | `#FEF3C7` | `#92400E` |

## 3. Typography

- Font family: `Inter` (fallback: `Titillium Web`, `system-ui`, `sans-serif`)
- Heading 1: 24px / Bold (700) / Line-height 1.3
- Heading 2: 20px / Semibold (600) / Line-height 1.35
- Heading 3: 16px / Semibold (600) / Line-height 1.4
- Body: 14px / Regular (400) / Line-height 1.5
- Body Small: 13px / Regular (400)
- Caption: 12px / Regular (400) / Uppercase untuk badge
- Button: 13px / Semibold (600) / Uppercase / Letter-spacing 0.5px

## 4. Spacing

- Base unit: 4px
- Grid: 8px
- Container padding: 24px (desktop), 16px (mobile)
- Card padding: 24px
- Gap antar card: 16px
- Gap antar section: 24px
- Page top margin (setelah navbar): 80px
- Sidebar width: 256px

## 5. Border Radius

- Card: 12px
- Button: 8px
- Input: 8px
- Badge: 6px
- Modal: 16px
- Avatar: full (circle)

## 6. Shadow

- Card: `0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)`
- Modal: `0 10px 25px rgba(0,0,0,0.1)`
- Dropdown: `0 4px 12px rgba(0,0,0,0.08)`

## 7. Components

### Button

- Primary: bg `#DE1B1B`, text white, padding 10px 16px, rounded-lg, uppercase, semibold
- Secondary: border `#DE1B1B`, text `#DE1B1B`, bg white
- Ghost: text `#6B7280`, bg transparent, hover bg `#F3F4F6`
- Danger: bg `#991B1B`, text white
- Disabled: bg `#E5E7EB`, text `#9CA3AF`, cursor not-allowed
- Sizes: sm (h-8), md (h-10), lg (h-12)
- Icon: 16px, gap 8px dari text

### Input

- Height: 40px
- Border: 1px `#D1D5DB`
- Focus: border `#DE1B1B`, ring `#FEE2E2`
- Placeholder: `#9CA3AF`
- Padding: 12px
- Label: 13px semibold, mb-6px

### Dropdown

- Sama dengan input, plus chevron icon kanan
- Menu: bg white, shadow, rounded-lg, py-4px
- Item: padding 10px 12px, hover bg `#F9FAFB`

### Badge (Status)

- Padding: 4px 8px
- Rounded: 6px
- Font: 11px uppercase bold
- Warna sesuai mapping status

### Card (Visit)

- BG white, rounded-xl, shadow-sm
- Padding: 20px
- Grid 2 kolom (desktop), 1 kolom (mobile)
- Label: 12px semibold `#6B7280`
- Value: 14px regular `#1A1A1A`
- Gap antar field: 16px

### Table

- Header: bg `#F9FAFB`, 12px uppercase semibold `#6B7280`
- Row: 14px regular, padding 12px 16px, border-b `#E5E7EB`
- Hover: bg `#F9FAFB`
- Responsive: jadi card di mobile

### Sidebar

- Width: 256px
- BG: white
- Border-right: 1px `#E5E7EB`
- Item: padding 12px 24px, icon 20px, text 14px
- Active: bg `#FEE2E2`, text `#DE1B1B`, border-left 3px `#DE1B1B`
- Hover: bg `#F9FAFB`

### Navbar

- Height: 64px
- BG: white, border-bottom 1px `#E5E7EB`
- Kiri: logo THC (32px height)
- Kanan: Help, bell icon (dengan badge), avatar + email + chevron

### Pagination

- Item: 32px x 32px, rounded-md
- Active: bg `#DE1B1B`, text white
- Default: bg white, border `#E5E7EB`
- Disabled: text `#D1D5DB`

### Modal

- Overlay: `rgba(0,0,0,0.4)`
- Box: bg white, rounded-2xl, max-width 480px, padding 24px
- Header: 18px semibold
- Body: 14px regular
- Footer: 2 button (secondary + primary), align kanan

### Toast

- Posisi: top-right
- BG white, border-left 4px sesuai status
- Padding: 16px
- Auto-dismiss: 5 detik

### Empty State

- Icon 64px (muted)
- Title: 16px semibold
- Description: 14px regular muted
- CTA: button primary

### Loading Skeleton

- BG: `#E5E7EB`
- Animation: pulse
- Shape: sesuai konten

## 8. Iconography

- Library: Lucide / Heroicons
- Size: 16px (inline), 20px (sidebar), 24px (navbar)
- Stroke: 2px
- Warna: mengikuti text

## 9. Layout Rules

### Desktop (>= 1024px)

- Sidebar fixed kiri 256px
- Navbar fixed atas 64px
- Konten: max-width 1200px, padding 24px, margin-left 256px

### Tablet (768–1023px)

- Sidebar collapse jadi icon-only (64px)
- Bisa expand via toggle
- Konten full width

### Mobile (< 768px)

- Sidebar jadi drawer (overlay)
- Navbar: logo + hamburger + avatar
- Konten full width, padding 16px
- Card jadi 1 kolom
- Table jadi card

## 10. Accessibility

- Contrast minimal WCAG AA
- Focus visible dengan ring
- Keyboard navigable
- ARIA labels untuk icon-only button
- Alt text untuk gambar
