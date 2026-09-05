/**
 * Прапорець панелі розробника.
 */
export default function Checkbox({
  checked,
  onChange,
  disabled = false,
  hint = null,
  className,
  children = null,
  type: _ignoredType,
  ...rest
}) {
  return (
    <label className={children ? "dp-check" : "dp-check dp-check-bare"}>
      <input
        type="checkbox"
        className={className}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        {...rest}
      />
      {children ? (
        <span className="dp-check-text">
          {children}
          {hint ? <span className="dp-check-hint">{hint}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
