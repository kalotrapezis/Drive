#pragma once

#include <QtGlobal>

namespace LocalDrive::WirelessProtocol {
inline constexpr quint16 DiscoveryPort = 43170;
inline constexpr int Version = 1;
inline constexpr int MaxHeaderBytes = 64 * 1024;
inline constexpr int MaxPayloadBytes = 8 * 1024 * 1024;
inline constexpr char Magic[] = "local-drive-discovery-v1";
}
