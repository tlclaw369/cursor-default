export function qualifyName(input: string, zoneName: string): string {
  const zone = zoneName.trim().replace(/\.$/, "");
  const name = input.trim().replace(/\.$/, "");
  if (name === "" || name === "@") return zone;
  const lowerName = name.toLowerCase();
  const lowerZone = zone.toLowerCase();
  if (lowerName === lowerZone || lowerName.endsWith(`.${lowerZone}`)) return name;
  return `${name}.${zone}`;
}

export function displayName(fqdn: string, zoneName: string): string {
  const name = fqdn.trim().replace(/\.$/, "");
  const zone = zoneName.trim().replace(/\.$/, "");
  const lowerName = name.toLowerCase();
  const lowerZone = zone.toLowerCase();
  if (lowerName === lowerZone) return "@";
  const suffix = `.${lowerZone}`;
  if (lowerName.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}
