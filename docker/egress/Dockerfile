FROM alpine:3.20
# Run squid as the unprivileged `squid` user from the start so it never drops
# privileges and can still open the inherited /dev/stdout for access_log.
RUN apk add --no-cache squid \
 && mkdir -p /var/cache/squid /var/log/squid \
 && touch /run/squid.pid \
 && chown -R squid:squid /var/cache/squid /var/log/squid /run/squid.pid
USER squid
CMD ["squid", "-N", "-f", "/etc/squid/orch.conf"]
