from django.db import models


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class BackupSettings(models.Model):
    """Automatic backups (one row). The `backup_worker` process reads this every minute."""

    INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24]

    enabled = models.BooleanField(default=True)
    interval_hours = models.PositiveSmallIntegerField(
        default=3, choices=[(h, f"Every {h} h") for h in INTERVALS]
    )
    keep_days = models.PositiveSmallIntegerField(default=7)
    # What happened last time, for the Settings page.
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_ok = models.BooleanField(default=True)
    last_error = models.TextField(blank=True)
    last_file = models.CharField(max_length=200, blank=True)

    class Meta:
        verbose_name_plural = "backup settings"

    def __str__(self):
        return "Backup settings"

    @classmethod
    def load(cls) -> "BackupSettings":
        return cls.objects.get_or_create(pk=1)[0]
