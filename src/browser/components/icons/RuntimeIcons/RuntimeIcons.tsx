interface IconProps {
  size?: number;
  className?: string;
}

/** Server rack icon for SSH runtime */
export function SSHIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="SSH Runtime"
      className={className}
    >
      <rect x="2" y="2" width="12" height="5" rx="1" />
      <rect x="2" y="9" width="12" height="5" rx="1" />
      <circle cx="5" cy="4.5" r="0.5" fill="currentColor" />
      <circle cx="5" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Git branch icon for worktree runtime */
export function WorktreeIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Worktree Runtime"
      className={className}
    >
      {/* Simplified git branch: vertical line with branch off */}
      <g transform="translate(-1 0)">
        <circle cx="7" cy="3" r="2" />
        <circle cx="7" cy="13" r="2" />
        <line x1="7" y1="5" x2="7" y2="11" />
        <circle cx="13" cy="7" r="2" />
        <path d="M11 7 L7 9" />
      </g>
    </svg>
  );
}

/** Folder icon for local project-dir runtime */
export function LocalIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Local Runtime"
      className={className}
    >
      {/* Folder icon */}
      <path d="M2 4 L2 13 L14 13 L14 5 L8 5 L7 3 L2 3 L2 4" />
    </svg>
  );
}

/** Coder logo icon for Coder-backed SSH runtime */
export function CoderIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 425.93 200"
      fill="currentColor"
      aria-label="Coder Runtime"
      className={className}
    >
      {/* Coder shorthand logo: stylized "C" with cursor block */}
      <rect x="263.75" y="5.41" width="162.18" height="189.24" />
      <path d="M0,100C0,38.92,51.89,0,123.25,0s111.35,33.78,112.7,83.51l-61.62,1.89c-1.62-27.57-26.03-45.68-51.08-45.14-34.32.74-59.73,23.51-59.73,59.73s25.41,58.65,59.73,58.65c25.05,0,48.91-17.3,51.62-44.86l61.62,1.35c-1.62,50.54-44.05,84.87-113.24,84.87S0,160.81,0,100Z" />
    </svg>
  );
}

/** Container icon for Docker runtime */
export function DockerIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Docker Runtime"
      className={className}
    >
      {/* Shipping container / cube icon */}
      <path d="M2 5 L8 2 L14 5 L14 11 L8 14 L2 11 Z" />
      <path d="M8 2 L8 14" />
      <path d="M2 5 L8 8 L14 5" />
      <path d="M8 8 L8 14" />
    </svg>
  );
}

/** Dev container icon for devcontainer runtime */
export function DevcontainerIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Dev container runtime"
      className={className}
    >
      {/* Container frame with code brackets */}
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M6 6 L4.5 8 L6 10" />
      <path d="M10 6 L11.5 8 L10 10" />
    </svg>
  );
}
