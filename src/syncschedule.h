#pragma once
#include <QDateTime>
#include <QTimeZone>
#include <QJsonObject>

inline QDateTime nextScheduledTime(const QJsonObject &schedule, const QDateTime &after) {
    const QTimeZone zone(schedule.value("timeZone").toString().toUtf8());
    const auto local = QDateTime::fromString(schedule.value("start").toString(), "yyyy-MM-dd'T'HH:mm");
    const QDateTime anchor(local.date(), local.time(), zone);
    if (!anchor.isValid() || !zone.isValid()) return {};
    if (anchor > after) return anchor;
    const QString repeat = schedule.value("repeat").toString();
    if (repeat == "once") return {};
    const QDate date = after.toTimeZone(zone).date();
    if (repeat == "monthly") {
        int months = (date.year() - anchor.date().year()) * 12 + date.month() - anchor.date().month();
        auto next = anchor.addMonths(months);
        if (next <= after) next = anchor.addMonths(months + 1);
        return next;
    }
    if (repeat != "daily" && repeat != "weekly") return {};
    const int step = repeat == "weekly" ? 7 : 1;
    const qint64 days = anchor.date().daysTo(date);
    auto next = anchor.addDays(days / step * step);
    if (next <= after) next = anchor.addDays((days / step + 1) * step);
    return next;
}
