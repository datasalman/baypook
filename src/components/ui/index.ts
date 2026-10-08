/**
 * BayPook admin UI kit. Phone-first, one-handed: every control is at least 44px,
 * plain words, high contrast, visible focus, reduced motion respected.
 *
 * Server-compatible: Button, Card, PageHeader, Field, Input, Select, Textarea,
 * Checkbox, Badge, EmptyState, Stat, Banner, SectionTitle, TopBar.
 * Client: SegmentedControl, ConfirmButton, Toast, FlashToast, DateNav, BottomNav.
 */
export { cn } from "./cn";
export { Button, buttonClasses, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Card, type CardProps, type CardTone } from "./Card";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export {
  Field,
  Input,
  Select,
  Textarea,
  Checkbox,
  describedBy,
  type FieldProps,
  type InputProps,
  type SelectProps,
  type TextareaProps,
  type CheckboxProps,
} from "./Form";
export { Badge, STATUS_BADGES, type BadgeProps, type BadgeStatus, type BadgeTone } from "./Badge";
export { EmptyState, Stat, Banner, SectionTitle, type EmptyStateProps, type StatProps, type BannerProps } from "./Misc";
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "./SegmentedControl";
export { ConfirmButton, type ConfirmButtonProps } from "./ConfirmButton";
export { Toast, FlashToast, type ToastProps } from "./Toast";
export { withFlash, FLASH_PARAM, FLASH_KIND_PARAM, type FlashKind } from "./flash";
export { DateNav, type DateNavProps } from "./DateNav";
export { BottomNav, DEFAULT_NAV, NAV_ICONS, type NavItem } from "./BottomNav";
export { TopBar, type TopBarProps } from "./TopBar";
export { brandColours, brandCss, contrastRatio, safeHex, FALLBACK_BRAND, FALLBACK_INK } from "./brand";
