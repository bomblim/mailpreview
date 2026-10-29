<#-- 시스템 알림 메일 (FreeMarker) : 데이터셋 탭의 JSON 과 바인딩됩니다 -->
<#assign brand = "#F37321">
<#assign statusInfo = {
  "DONE":     {"label": "처리 완료", "color": "#C4520A", "bg": "#FDEBDF"},
  "PENDING":  {"label": "처리 중",   "color": "#8A6100", "bg": "#FFF4D6"},
  "REJECTED": {"label": "반려",      "color": "#B3261E", "bg": "#FCE8E6"}
}>
<#assign st = statusInfo[request.status]!{"label": request.status, "color": "#555555", "bg": "#EEEEEE"}>
<#assign font = "font-family:'Malgun Gothic',Arial,sans-serif;">
<#-- 상세 정보 표의 한 줄 -->
<#macro row label valign="middle">
              <tr>
                <td class="label" width="120" valign="${valign}" bgcolor="#fafafa" style="padding:11px 14px;background-color:#fafafa;border-bottom:1px solid #e5e5e5;${font}font-size:13px;line-height:20px;font-weight:bold;color:#555555;">${label}</td>
                <td style="padding:11px 14px;border-bottom:1px solid #e5e5e5;${font}font-size:13px;line-height:20px;color:#222222;"><#nested></td>
              </tr>
</#macro>
<!DOCTYPE html>
<html lang="ko" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>[${system.name}] ${request.type} 건이 ${st.label} 되었습니다</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style>td,th,div,p,a,h1,span{font-family:"Malgun Gothic",Arial,sans-serif !important;}</style>
<![endif]-->
<style>
  @media (max-width:620px) {
    .container { width:100% !important; }
    .px { padding-left:20px !important; padding-right:20px !important; }
    .label { width:90px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f4;">요청번호 ${request.id} - ${st.label}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4" style="background-color:#f4f4f4;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;background-color:#ffffff;border:1px solid #e5e5e5;">

        <tr><td height="6" bgcolor="${brand}" style="height:6px;font-size:0;line-height:0;background-color:${brand};">&nbsp;</td></tr>

        <tr>
          <td class="px" style="padding:20px 32px;border-bottom:1px solid #eeeeee;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="${font}font-size:18px;line-height:24px;font-weight:bold;color:${brand};">${system.name}</td>
                <td align="right" style="${font}font-size:12px;line-height:24px;color:#888888;">시스템 자동 알림</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td class="px" style="padding:32px 32px 8px;${font}">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="${st.bg}" style="padding:4px 10px;background-color:${st.bg};${font}font-size:12px;line-height:16px;font-weight:bold;color:${st.color};">${st.label}</td>
              </tr>
            </table>
            <h1 style="margin:14px 0 0;${font}font-size:22px;line-height:32px;font-weight:bold;color:#222222;">${request.type} 건이 ${st.label} 되었습니다</h1>
          </td>
        </tr>

        <tr>
          <td class="px" style="padding:12px 32px 24px;${font}font-size:14px;line-height:23px;color:#444444;">
            ${recipient.name} 님, 안녕하세요.<br>
            요청하신 건의 처리 결과를 알려드립니다.
          </td>
        </tr>

        <tr>
          <td class="px" style="padding:0 32px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:2px solid ${brand};">
<@row label="요청번호">${request.id}</@row>
<@row label="요청 구분">${request.type}</@row>
<@row label="요청자">${recipient.name} (${recipient.dept})</@row>
<@row label="요청일시">${request.requestedAt?datetime.iso?string("yyyy-MM-dd HH:mm")}</@row>
<#if request.processedAt??>
<@row label="처리일시">${request.processedAt?datetime.iso?string("yyyy-MM-dd HH:mm")}</@row>
</#if>
<@row label="처리상태"><strong style="color:${st.color};">${st.label}</strong></@row>
<@row label="처리 내용" valign="top"><#list request.details as line>${line}<#sep><br></#list></@row>
<#if request.comment?has_content>
<@row label="담당자 의견" valign="top">${request.comment}</@row>
</#if>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" class="px" style="padding:0 32px 32px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${system.url}/requests/${request.id}" style="height:46px;v-text-anchor:middle;width:220px;" arcsize="9%" stroke="f" fillcolor="${brand}">
              <w:anchorlock/>
              <center style="color:#ffffff;font-family:'Malgun Gothic',Arial,sans-serif;font-size:15px;font-weight:bold;">시스템에서 확인하기</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="${system.url}/requests/${request.id}" style="display:inline-block;background-color:${brand};color:#ffffff;${font}font-size:15px;line-height:46px;font-weight:bold;text-decoration:none;width:220px;text-align:center;border-radius:4px;">시스템에서 확인하기</a>
            <!--<![endif]-->
          </td>
        </tr>

<#if notices?has_content>
        <tr>
          <td class="px" style="padding:0 32px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#fff7f1" style="padding:14px 16px;background-color:#fff7f1;border-left:4px solid ${brand};${font}font-size:12px;line-height:20px;color:#666666;">
                  <strong style="color:#C4520A;">안내</strong><br>
                  <#list notices as n>· ${n}<#sep><br></#list>
                </td>
              </tr>
            </table>
          </td>
        </tr>
</#if>

        <tr>
          <td class="px" bgcolor="#f8f8f8" style="padding:20px 32px;background-color:#f8f8f8;border-top:1px solid #eeeeee;${font}font-size:11px;line-height:18px;color:#999999;">
            본 메일은 발신 전용으로 회신되지 않습니다.<br>
            문의: ${contact.dept} ${contact.name} (내선 ${contact.ext})<#if contact.email?has_content> · <a href="mailto:${contact.email}" style="color:#999999;text-decoration:underline;">${contact.email}</a></#if>
          </td>
        </tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>
